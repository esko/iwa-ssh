import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Identity, KnownHost, Profile } from '../settings/types';
import { normalizeIdentity } from './identityNormalize';

interface GoshDb extends DBSchema {
  /** Unused legacy store kept for schema continuity; no live readers/writers. */
  settings: {
    key: 'app';
    value: unknown;
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
  savedPasswords: {
    key: string;
    value: SavedPasswordRecord;
  };
  vaultMeta: {
    key: string;
    value: VaultKeyRecord;
  };
  hostScreenshots: {
    key: string;
    value: HostScreenshotRecord;
  };
}

const DB_NAME = 'gosh';
const DB_VERSION = 5;

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

/**
 * An SSH password encrypted at rest with the device key (AES-GCM, non-extractable
 * CryptoKey held in `etMeta`). Keyed by `${username}@${host}:${port}` so a saved
 * password auto-fills the next connect to the same target. The device-key model
 * means the password is protected against disk/export inspection but not behind a
 * master passphrase — it is usable by anyone with the unlocked app, which is why
 * saving is strictly opt-in.
 */
export type SavedPasswordRecord = {
  credentialKey: string;
  username: string;
  host: string;
  port: number;
  iv: Uint8Array;
  ciphertext: ArrayBuffer;
  savedAt: number;
};

/**
 * A wrapped copy of the credential-vault data key (DEK). The same 32-byte DEK is
 * stored under two ids: `dek-device` (sealed with the non-extractable device key,
 * enables silent auto-unlock) and `dek-master` (sealed with a PBKDF2 key derived
 * from the user's master password, the durable copy + recovery path). `salt` is
 * present only on the master-wrapped record. See {@link credentialVault}.
 */
export type VaultKeyRecord = {
  id: string;
  salt?: Uint8Array;
  iv: Uint8Array;
  ciphertext: ArrayBuffer;
};

/**
 * A captured terminal thumbnail for a saved host, keyed by `hostTargetKey` (the
 * same identity used for liveness). Populated from the tab-overview preview
 * machinery so the launcher can show a real session screenshot on the host card
 * instead of the placeholder glyph. Best-effort and disposable — losing it just
 * falls back to the glyph.
 */
export type HostScreenshotRecord = {
  hostKey: string;
  blob: Blob;
  updatedAt: number;
};

let dbPromise: Promise<IDBPDatabase<GoshDb>> | null = null;
let deviceKeyPromise: Promise<CryptoKey> | null = null;

/** Close the cached connection. Exported for deterministic storage migration tests. */
export async function resetIndexedDbConnection(): Promise<void> {
  const db = await dbPromise?.catch(() => null);
  db?.close();
  dbPromise = null;
  deviceKeyPromise = null;
}

function getDb(): Promise<IDBPDatabase<GoshDb>> {
  if (!dbPromise) {
    dbPromise = openDB<GoshDb>(DB_NAME, DB_VERSION, {
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
        if (oldVersion < 3) {
          db.createObjectStore('savedPasswords', { keyPath: 'credentialKey' });
        }
        if (oldVersion < 4) {
          db.createObjectStore('vaultMeta', { keyPath: 'id' });
        }
        if (oldVersion < 5) {
          db.createObjectStore('hostScreenshots', { keyPath: 'hostKey' });
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

export async function saveEtOutboundFrame(
  frame: EtOutboundFrame,
  rotateOldest = false,
  options?: { sessionHint?: EtSessionRecord },
): Promise<EtSessionRecord> {
  const db = await getDb();
  const tx = db.transaction(['etOutboundFrames', 'etSessions'], 'readwrite');
  const session = await tx.objectStore('etSessions').get(frame.sessionId);
  if (!session) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new Error(`ET session ${frame.sessionId} is missing`);
  }
  const frameStore = tx.objectStore('etOutboundFrames');
  const frameKey: [string, number] = [frame.sessionId, frame.sequence];
  const existingFrame = await frameStore.get(frameKey);
  if (existingFrame) {
    const next = {
      ...session,
      txSequence: Math.max(session.txSequence, frame.sequence),
      updatedAt: Date.now(),
    };
    if (next.txSequence !== session.txSequence) {
      await tx.objectStore('etSessions').put(next);
    }
    await tx.done;
    return next;
  }
  if (frame.sequence !== session.txSequence + 1) {
    const baselineTx = Math.max(session.txSequence, options?.sessionHint?.txSequence ?? -1);
    if (frame.sequence !== baselineTx + 1) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw new Error(`Non-contiguous ET outbound sequence ${frame.sequence}; expected ${baselineTx + 1}`);
    }
  }
  let outboundBytes = session.outboundBytes + frame.size;
  if (!rotateOldest && outboundBytes > 64 * 1024 * 1024) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new Error('ET disconnected input buffer reached 64 MiB');
  }
  await frameStore.add(frame);
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
  const stored = await tx.objectStore('etSessions').get(sessionId);
  if (!stored) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new Error(`ET session ${sessionId} is missing`);
  }
  if (chunk) {
    const key: [string, number] = [chunk.sessionId, chunk.sequence];
    const existing = await tx.objectStore('etJournal').get(key);
    if (existing) {
      const next = {
        ...stored,
        rxSequence: Math.max(stored.rxSequence, sequence),
        updatedAt: Date.now(),
      };
      if (!options?.deferSessionPut) await tx.objectStore('etSessions').put(next);
      await tx.done;
      return next;
    }
  }
  const baselineRx = Math.max(stored.rxSequence, options?.sessionHint?.rxSequence ?? -1);
  if (sequence !== baselineRx + 1) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new Error(`Non-contiguous ET inbound sequence ${sequence}; expected ${baselineRx + 1}`);
  }
  let journalBytes = stored.journalBytes + (chunk?.size ?? 0);
  let journalTruncated = stored.journalTruncated;
  const journalStore = tx.objectStore('etJournal');
  if (chunk) {
    const key: [string, number] = [chunk.sessionId, chunk.sequence];
    const existing = await journalStore.get(key);
    if (!existing) {
      await journalStore.add(chunk);
    } else {
      journalBytes = stored.journalBytes;
    }
  }
  let cursor = await journalStore.index('by-session').openCursor(IDBKeyRange.only(sessionId));
  while (cursor && journalBytes > 64 * 1024 * 1024) {
    journalBytes -= cursor.value.size;
    journalTruncated = true;
    await cursor.delete();
    cursor = await cursor.continue();
  }
  const next = {
    ...stored,
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

export type EtLocalDataSummary = {
  sessions: number;
  outboundFrames: number;
  journalChunks: number;
  hasDeviceKey: boolean;
};

export async function summarizeEtLocalData(): Promise<EtLocalDataSummary> {
  const db = await getDb();
  const [sessions, outboundFrames, journalChunks, deviceKey] = await Promise.all([
    db.getAll('etSessions'),
    db.getAll('etOutboundFrames'),
    db.getAll('etJournal'),
    db.get('etMeta', 'device-key'),
  ]);
  return {
    sessions: sessions.length,
    outboundFrames: outboundFrames.length,
    journalChunks: journalChunks.length,
    hasDeviceKey: Boolean(deviceKey),
  };
}

/**
 * Remove every ET session, recovery journal, wrapped passkey, and the local
 * device encryption key. Also clears saved SSH passwords and the master-password
 * vault because they are sealed with the same device key.
 */
export async function purgeAllEtLocalData(): Promise<{ sessions: number; savedPasswords: number }> {
  const db = await getDb();
  const [sessions, savedPasswords] = await Promise.all([
    db.getAll('etSessions'),
    db.getAll('savedPasswords'),
  ]);
  const tx = db.transaction(
    ['etSessions', 'etOutboundFrames', 'etJournal', 'etMeta', 'savedPasswords', 'vaultMeta'],
    'readwrite',
  );
  await tx.objectStore('etSessions').clear();
  await tx.objectStore('etOutboundFrames').clear();
  await tx.objectStore('etJournal').clear();
  await tx.objectStore('etMeta').delete('device-key');
  await tx.objectStore('savedPasswords').clear();
  await tx.objectStore('vaultMeta').clear();
  await tx.done;
  deviceKeyPromise = null;
  return { sessions: sessions.length, savedPasswords: savedPasswords.length };
}

/** Drop recovery rows for a session without deleting the session record itself. */
export async function clearEtSessionRecovery(sessionId: string): Promise<EtSessionRecord | undefined> {
  const db = await getDb();
  const tx = db.transaction(['etSessions', 'etOutboundFrames', 'etJournal'], 'readwrite');
  const session = await tx.objectStore('etSessions').get(sessionId);
  if (!session) {
    tx.abort();
    await tx.done.catch(() => undefined);
    return undefined;
  }
  for (const name of ['etOutboundFrames', 'etJournal'] as const) {
    let cursor = await tx.objectStore(name).index('by-session').openCursor(IDBKeyRange.only(sessionId));
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
  }
  const next: EtSessionRecord = {
    ...session,
    rxSequence: 0,
    txSequence: 0,
    txAcknowledged: 0,
    outboundBytes: 0,
    journalBytes: 0,
    journalTruncated: false,
    updatedAt: Date.now(),
  };
  await tx.objectStore('etSessions').put(next);
  await tx.done;
  return next;
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

/** Store/replace the latest terminal thumbnail for a host (keyed by hostTargetKey). */
export async function saveHostScreenshot(hostKey: string, blob: Blob): Promise<void> {
  const db = await getDb();
  await db.put('hostScreenshots', { hostKey, blob, updatedAt: Date.now() });
}

/** All saved host thumbnails as a `hostKey → blob` map for the launcher. */
export async function listHostScreenshots(): Promise<Map<string, Blob>> {
  const db = await getDb();
  const records = await db.getAll('hostScreenshots');
  return new Map(records.map((record) => [record.hostKey, record.blob]));
}

export async function deleteHostScreenshot(hostKey: string): Promise<void> {
  const db = await getDb();
  await db.delete('hostScreenshots', hostKey);
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

/** Remove every trusted host key from IndexedDB. Returns the number cleared. */
export async function clearKnownHosts(): Promise<number> {
  const db = await getDb();
  const all = await db.getAll('knownHosts');
  if (all.length === 0) return 0;
  await db.clear('knownHosts');
  return all.length;
}

export async function putSavedPassword(record: SavedPasswordRecord): Promise<void> {
  await (await getDb()).put('savedPasswords', record);
}

export async function getSavedPasswordRecord(credentialKey: string): Promise<SavedPasswordRecord | undefined> {
  return (await getDb()).get('savedPasswords', credentialKey);
}

export async function deleteSavedPasswordRecord(credentialKey: string): Promise<void> {
  await (await getDb()).delete('savedPasswords', credentialKey);
}

export async function listSavedPasswordRecords(): Promise<SavedPasswordRecord[]> {
  return (await getDb()).getAll('savedPasswords');
}

export async function getVaultKeyRecord(id: string): Promise<VaultKeyRecord | undefined> {
  return (await getDb()).get('vaultMeta', id);
}

export async function putVaultKeyRecord(record: VaultKeyRecord): Promise<void> {
  await (await getDb()).put('vaultMeta', record);
}

export async function deleteVaultKeyRecord(id: string): Promise<void> {
  await (await getDb()).delete('vaultMeta', id);
}
