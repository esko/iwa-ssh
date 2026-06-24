import {
  getEtDeviceKey,
  getEtSession,
  listEtJournalChunks,
  listEtOutboundFrames,
  clearEtSessionRecovery,
  checkpointEtInbound,
  saveEtSession,
  type EtSessionRecord,
} from '../storage/indexedDb';

const JOURNAL_LIMIT = 64 * 1024 * 1024;
const SESSION_FLUSH_MS = 250;

type PendingSessionFlush = {
  session: EtSessionRecord;
  timer: ReturnType<typeof setTimeout> | null;
};

const pendingSessionFlush = new Map<string, PendingSessionFlush>();

function bytes(value: ArrayBuffer): Uint8Array {
  return new Uint8Array(value);
}

function owned(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

/** Clear debounced session checkpoints (tests / IDB reset). */
export function resetSessionCheckpointFlushes(): void {
  for (const entry of pendingSessionFlush.values()) {
    if (entry.timer) clearTimeout(entry.timer);
  }
  pendingSessionFlush.clear();
}

/** Persist any debounced session-record checkpoint immediately. */
export async function flushEtSessionCheckpoint(sessionId: string): Promise<EtSessionRecord | undefined> {
  const entry = pendingSessionFlush.get(sessionId);
  if (!entry) return undefined;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  pendingSessionFlush.delete(sessionId);
  const stored = await getEtSession(sessionId);
  const merged = stored
    ? {
        ...stored,
        rxSequence: entry.session.rxSequence,
        journalBytes: entry.session.journalBytes,
        journalTruncated: entry.session.journalTruncated,
        updatedAt: Date.now(),
      }
    : entry.session;
  await saveEtSession(merged);
  return merged;
}

function scheduleSessionRecordFlush(sessionId: string, session: EtSessionRecord): EtSessionRecord {
  const entry = pendingSessionFlush.get(sessionId) ?? { session, timer: null };
  entry.session = session;
  if (!entry.timer) {
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void flushEtSessionCheckpoint(sessionId);
    }, SESSION_FLUSH_MS);
  }
  pendingSessionFlush.set(sessionId, entry);
  return session;
}

export async function wrapEtPasskey(passkey: string): Promise<{ iv: Uint8Array; ciphertext: ArrayBuffer }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await getEtDeviceKey();
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(passkey));
  return { iv, ciphertext };
}

export async function unwrapEtPasskey(session: EtSessionRecord): Promise<string> {
  const key = await getEtDeviceKey();
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: owned(session.passkeyIv) },
    key,
    session.wrappedPasskey,
  );
  return new TextDecoder().decode(plaintext);
}

export async function updateEtSession(
  id: string,
  patch: Partial<Omit<EtSessionRecord, 'id'>>,
): Promise<EtSessionRecord> {
  const current = await getEtSession(id);
  if (!current) throw new Error(`ET session ${id} is missing`);
  const next = { ...current, ...patch, updatedAt: Date.now() };
  await saveEtSession(next);
  return next;
}

/**
 * Align session sequence counters with recovery stores before connect.
 * Clears orphaned frames/journal left by a failed first connect (tx/rx still 0).
 */
export async function prepareEtSessionForConnect(sessionId: string): Promise<EtSessionRecord> {
  await flushEtSessionCheckpoint(sessionId);
  const session = await getEtSession(sessionId);
  if (!session) throw new Error(`ET session ${sessionId} is missing`);

  const frames = await listEtOutboundFrames(sessionId);
  const chunks = await listEtJournalChunks(sessionId);
  const maxTx = frames.reduce((max, frame) => Math.max(max, frame.sequence), session.txSequence);
  const maxRx = chunks.reduce((max, chunk) => Math.max(max, chunk.sequence), session.rxSequence);

  if (session.txSequence === 0 && session.rxSequence === 0 && (frames.length > 0 || chunks.length > 0)) {
    const cleared = await clearEtSessionRecovery(sessionId);
    if (!cleared) throw new Error(`ET session ${sessionId} is missing`);
    return cleared;
  }

  if (maxTx === session.txSequence && maxRx === session.rxSequence) return session;

  return updateEtSession(sessionId, {
    txSequence: maxTx,
    rxSequence: maxRx,
    outboundBytes: frames.reduce((sum, frame) => sum + frame.size, 0),
    journalBytes: chunks.reduce((sum, chunk) => sum + chunk.size, 0),
  });
}

export async function checkpointEtOutput(
  sessionId: string,
  sequence: number,
  data: Uint8Array,
  sessionHint: EtSessionRecord,
): Promise<EtSessionRecord> {
  const key = await getEtDeviceKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, owned(data));
  const next = await checkpointEtInbound(
    { sessionId, sequence, iv, ciphertext, size: data.byteLength },
    sessionId,
    sequence,
    { sessionHint, deferSessionPut: true },
  );
  scheduleSessionRecordFlush(sessionId, next);
  return next;
}

export async function checkpointEtControl(
  sessionId: string,
  sequence: number,
  sessionHint?: EtSessionRecord,
): Promise<EtSessionRecord> {
  await flushEtSessionCheckpoint(sessionId);
  return checkpointEtInbound(null, sessionId, sequence, sessionHint ? { sessionHint } : undefined);
}

export async function readEtJournal(sessionId: string): Promise<Uint8Array[]> {
  const key = await getEtDeviceKey();
  const chunks = await listEtJournalChunks(sessionId);
  let retained = 0;
  const selected = [];
  for (const chunk of chunks.reverse()) {
    if (retained + chunk.size > JOURNAL_LIMIT) break;
    retained += chunk.size;
    selected.push(chunk);
  }
  selected.reverse();
  return Promise.all(selected.map(async (chunk) => {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: owned(chunk.iv) }, key, chunk.ciphertext);
    return bytes(plaintext);
  }));
}
