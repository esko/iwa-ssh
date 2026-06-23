import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { AppSettings, Identity, KnownHost, Profile } from '../settings/types';
import { DEFAULT_SETTINGS } from '../settings/defaults';
import { normalizeIdentity } from './identityNormalize';

interface IwaSshDb extends DBSchema {
  settings: {
    key: 'app';
    value: AppSettings;
  };
  profiles: {
    key: string;
    value: Profile;
    indexes: { 'by-last-connected': number };
  };
  identities: {
    key: string;
    value: Identity;
  };
  knownHosts: {
    key: string;
    value: KnownHost;
  };
  etMeta: {
    key: 'device-key';
    value: CryptoKey;
  };
  etSessions: {
    key: string;
    value: EtSessionRecord;
    indexes: { 'by-updated-at': number };
  };
  etOutboundFrames: {
    key: [string, number];
    value: EtOutboundFrame;
    indexes: { 'by-session': string };
  };
  etJournal: {
    key: [string, number];
    value: EtJournalChunk;
    indexes: { 'by-session': string };
  };
}

const DB_NAME = 'iwa-ssh';
const DB_VERSION = 2;

export type EtSessionPhase = 'bootstrapping' | 'active' | 'detached' | 'stale' | 'ended';

export type EtSessionRecord = {
  id: string;
  clientId: string;
  host: string;
  sshPort: number;
  etPort: number;
  username: string;
  profileId?: string;
  identityId?: string;
  settingsProfileId?: string;
  connectionArgs?: string;
  startupCommand?: string;
  wrappedPasskey: ArrayBuffer;
  passkeyIv: Uint8Array;
  phase: EtSessionPhase;
  protocolVersion: 6;
  storageFormatVersion: 1;
  rxSequence: number;
  txSequence: number;
  txAcknowledged: number;
  outboundBytes: number;
  journalBytes: number;
  journalTruncated: boolean;
  cols: number;
  rows: number;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
};

export type EtOutboundFrame = {
  sessionId: string;
  sequence: number;
  bytes: Uint8Array;
  size: number;
};

export type EtJournalChunk = {
  sessionId: string;
  sequence: number;
  iv: Uint8Array;
  ciphertext: ArrayBuffer;
  size: number;
};

let dbPromise: Promise<IDBPDatabase<IwaSshDb>> | null = null;
let deviceKeyPromise: Promise<CryptoKey> | null = null;

/** Close the cached connection. Exported for deterministic storage migration tests. */
export async function resetIndexedDbConnection(): Promise<void> {
  const db = await dbPromise?.catch(() => null);
  db?.close();
  dbPromise = null;
  deviceKeyPromise = null;
}

function getDb(): Promise<IDBPDatabase<IwaSshDb>> {
  if (!dbPromise) {
    dbPromise = openDB<IwaSshDb>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore('settings');
          const profiles = db.createObjectStore('profiles', { keyPath: 'id' });
          profiles.createIndex('by-last-connected', 'lastConnectedAt');
          db.createObjectStore('identities', { keyPath: 'id' });
          db.createObjectStore('knownHosts');
        }
        if (oldVersion < 2) {
          db.createObjectStore('etMeta');
          const sessions = db.createObjectStore('etSessions', { keyPath: 'id' });
          sessions.createIndex('by-updated-at', 'updatedAt');
          const frames = db.createObjectStore('etOutboundFrames', { keyPath: ['sessionId', 'sequence'] });
          frames.createIndex('by-session', 'sessionId');
          const journal = db.createObjectStore('etJournal', { keyPath: ['sessionId', 'sequence'] });
          journal.createIndex('by-session', 'sessionId');
        }
      },
      blocking() {
        dbPromise?.then((db) => db.close()).catch(() => undefined);
        dbPromise = null;
        deviceKeyPromise = null;
      },
      terminated() {
        dbPromise = null;
        deviceKeyPromise = null;
      },
    });
  }
  return dbPromise;
}

export async function getEtDeviceKey(): Promise<CryptoKey> {
  deviceKeyPromise ??= loadOrCreateEtDeviceKey();
  return deviceKeyPromise;
}

async function loadOrCreateEtDeviceKey(): Promise<CryptoKey> {
  const db = await getDb();
  const stored = await db.get('etMeta', 'device-key');
  if (stored) return stored;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  try {
    await db.add('etMeta', key, 'device-key');
    return key;
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== 'ConstraintError') throw error;
    const winner = await db.get('etMeta', 'device-key');
    if (!winner) throw new Error('ET device-key race did not produce a key');
    return winner;
  }
}

export async function saveEtSession(session: EtSessionRecord): Promise<void> {
  const db = await getDb();
  await db.put('etSessions', session);
}

export async function getEtSession(id: string): Promise<EtSessionRecord | undefined> {
  return (await getDb()).get('etSessions', id);
}

export async function listEtSessions(): Promise<EtSessionRecord[]> {
  const rows = await (await getDb()).getAllFromIndex('etSessions', 'by-updated-at');
  return rows.filter((row) => row.phase !== 'ended').sort((a, b) => b.updatedAt - a.updatedAt);
}

export type EtSessionSummary = Pick<EtSessionRecord, 'id' | 'host' | 'username' | 'etPort' | 'phase' | 'profileId' | 'createdAt' | 'updatedAt'>;

export async function listEtSessionSummaries(): Promise<EtSessionSummary[]> {
  return (await listEtSessions())
    .filter((row) => row.phase === 'active' || row.phase === 'detached')
    .map(({ id, host, username, etPort, phase, profileId, createdAt, updatedAt }) => ({ id, host, username, etPort, phase, profileId, createdAt, updatedAt }));
}

/** Forget sessions the server can no longer resume (INVALID_KEY → 'stale'). */
export async function purgeStaleEtSessions(): Promise<void> {
  const stale = (await listEtSessions()).filter((row) => row.phase === 'stale');
  for (const row of stale) await forgetEtSession(row.id);
}

export async function saveEtOutboundFrame(frame: EtOutboundFrame, rotateOldest = false): Promise<EtSessionRecord> {
  const db = await getDb();
  const tx = db.transaction(['etOutboundFrames', 'etSessions'], 'readwrite');
  const session = await tx.objectStore('etSessions').get(frame.sessionId);
  if (!session) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new Error(`ET session ${frame.sessionId} is missing`);
  }
  if (frame.sequence !== session.txSequence + 1) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new Error(`Non-contiguous ET outbound sequence ${frame.sequence}; expected ${session.txSequence + 1}`);
  }
  let outboundBytes = session.outboundBytes + frame.size;
  if (!rotateOldest && outboundBytes > 64 * 1024 * 1024) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new Error('ET disconnected input buffer reached 64 MiB');
  }
  await tx.objectStore('etOutboundFrames').add(frame);
  if (rotateOldest) {
    let cursor = await tx.objectStore('etOutboundFrames').index('by-session').openCursor(IDBKeyRange.only(frame.sessionId));
    while (cursor && outboundBytes > 64 * 1024 * 1024) {
      outboundBytes -= cursor.value.size;
      await cursor.delete();
      cursor = await cursor.continue();
    }
  }
  const next = { ...session, txSequence: frame.sequence, outboundBytes, updatedAt: Date.now() };
  await tx.objectStore('etSessions').put(next);
  await tx.done;
  return next;
}

export async function listEtOutboundFrames(sessionId: string): Promise<EtOutboundFrame[]> {
  const rows = await (await getDb()).getAllFromIndex('etOutboundFrames', 'by-session', sessionId);
  return rows.sort((a, b) => a.sequence - b.sequence);
}

export async function pruneEtOutboundFrames(sessionId: string, throughSequence: number): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['etOutboundFrames', 'etSessions'], 'readwrite');
  let cursor = await tx.objectStore('etOutboundFrames').index('by-session').openCursor(IDBKeyRange.only(sessionId));
  let removedBytes = 0;
  while (cursor) {
    if (cursor.value.sequence <= throughSequence) {
      removedBytes += cursor.value.size;
      await cursor.delete();
    }
    cursor = await cursor.continue();
  }
  const session = await tx.objectStore('etSessions').get(sessionId);
  if (session && throughSequence > session.txAcknowledged) {
    await tx.objectStore('etSessions').put({
      ...session,
      txAcknowledged: Math.min(throughSequence, session.txSequence),
      outboundBytes: Math.max(0, session.outboundBytes - removedBytes),
      updatedAt: Date.now(),
    });
  }
  await tx.done;
}

export async function checkpointEtInbound(
  chunk: EtJournalChunk | null,
  sessionId: string,
  sequence: number,
  options?: { sessionHint?: EtSessionRecord; deferSessionPut?: boolean },
): Promise<EtSessionRecord> {
  const db = await getDb();
  const tx = db.transaction(['etJournal', 'etSessions'], 'readwrite');
  const session = options?.sessionHint ?? await tx.objectStore('etSessions').get(sessionId);
  if (!session) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new Error(`ET session ${sessionId} is missing`);
  }
  if (sequence !== session.rxSequence + 1) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new Error(`Non-contiguous ET inbound sequence ${sequence}; expected ${session.rxSequence + 1}`);
  }
  let journalBytes = session.journalBytes + (chunk?.size ?? 0);
  let journalTruncated = session.journalTruncated;
  const journalStore = tx.objectStore('etJournal');
  if (chunk) await journalStore.add(chunk);
  let cursor = await journalStore.index('by-session').openCursor(IDBKeyRange.only(sessionId));
  while (cursor && journalBytes > 64 * 1024 * 1024) {
    journalBytes -= cursor.value.size;
    journalTruncated = true;
    await cursor.delete();
    cursor = await cursor.continue();
  }
  const next = {
    ...session,
    rxSequence: sequence,
    journalBytes,
    journalTruncated,
    updatedAt: Date.now(),
  };
  if (!options?.deferSessionPut) await tx.objectStore('etSessions').put(next);
  await tx.done;
  return next;
}

export async function listEtJournalChunks(sessionId: string): Promise<EtJournalChunk[]> {
  const rows = await (await getDb()).getAllFromIndex('etJournal', 'by-session', sessionId);
  return rows.sort((a, b) => a.sequence - b.sequence);
}

export async function forgetEtSession(id: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['etSessions', 'etOutboundFrames', 'etJournal'], 'readwrite');
  await tx.objectStore('etSessions').delete(id);
  for (const name of ['etOutboundFrames', 'etJournal'] as const) {
    let cursor = await tx.objectStore(name).index('by-session').openCursor(IDBKeyRange.only(id));
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
  }
  await tx.done;
}

export async function loadSettings(): Promise<AppSettings> {
  const db = await getDb();
  const stored = await db.get('settings', 'app');
  if (!stored) return structuredClone(DEFAULT_SETTINGS);
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    appearance: {
      ...DEFAULT_SETTINGS.appearance,
      ...stored.appearance,
    },
    keyboard: {
      ...DEFAULT_SETTINGS.keyboard,
      ...stored.keyboard,
    },
    behavior: {
      ...DEFAULT_SETTINGS.behavior,
      ...stored.behavior,
    },
    performance: {
      ...DEFAULT_SETTINGS.performance,
      ...stored.performance,
    },
  };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const db = await getDb();
  await db.put('settings', settings, 'app');
}

export async function listProfiles(): Promise<Profile[]> {
  const db = await getDb();
  const profiles = await db.getAll('profiles');
  return profiles.sort((a, b) => (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0));
}

export async function getProfile(id: string): Promise<Profile | undefined> {
  const db = await getDb();
  return db.get('profiles', id);
}

export async function saveProfile(profile: Profile): Promise<void> {
  const db = await getDb();
  await db.put('profiles', profile);
}

export async function deleteProfile(id: string): Promise<void> {
  const db = await getDb();
  await db.delete('profiles', id);
}

export async function listIdentities(): Promise<Identity[]> {
  const db = await getDb();
  const raw = await db.getAll('identities');
  return raw.map(normalizeIdentity);
}

export async function getIdentity(id: string): Promise<Identity | undefined> {
  const db = await getDb();
  const raw = await db.get('identities', id);
  return raw ? normalizeIdentity(raw) : undefined;
}

export async function saveIdentity(identity: Identity): Promise<void> {
  const db = await getDb();
  await db.put('identities', identity);
}

export async function deleteIdentity(id: string): Promise<void> {
  const db = await getDb();
  await db.delete('identities', id);
}

export function knownHostKey(host: string, port: number): string {
  return `${host}:${port}`;
}

export async function getKnownHost(host: string, port: number): Promise<KnownHost | undefined> {
  const db = await getDb();
  return db.get('knownHosts', knownHostKey(host, port));
}

export async function saveKnownHost(entry: KnownHost): Promise<void> {
  const db = await getDb();
  await db.put('knownHosts', entry, knownHostKey(entry.host, entry.port));
}

export async function listKnownHosts(): Promise<KnownHost[]> {
  const db = await getDb();
  return db.getAll('knownHosts');
}

export async function deleteKnownHost(host: string, port: number): Promise<void> {
  const db = await getDb();
  await db.delete('knownHosts', knownHostKey(host, port));
}
