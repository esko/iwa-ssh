import {
  getEtDeviceKey,
  getEtSession,
  listEtJournalChunks,
  checkpointEtInbound,
  saveEtSession,
  type EtSessionRecord,
} from '../storage/indexedDb';

const JOURNAL_LIMIT = 64 * 1024 * 1024;

function bytes(value: ArrayBuffer): Uint8Array {
  return new Uint8Array(value);
}

function owned(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
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

export async function checkpointEtOutput(sessionId: string, sequence: number, data: Uint8Array): Promise<EtSessionRecord> {
  const key = await getEtDeviceKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, owned(data));
  return checkpointEtInbound({ sessionId, sequence, iv, ciphertext, size: data.byteLength }, sessionId, sequence);
}

export async function checkpointEtControl(sessionId: string, sequence: number): Promise<EtSessionRecord> {
  return checkpointEtInbound(null, sessionId, sequence);
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
