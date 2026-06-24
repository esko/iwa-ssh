import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkpointEtInbound,
  getEtDeviceKey,
  getEtSession,
  listProfiles,
  resetIndexedDbConnection,
  saveEtOutboundFrame,
  saveEtSession,
  type EtSessionRecord,
} from './indexedDb';
import { checkpointEtOutput, flushEtSessionCheckpoint, prepareEtSessionForConnect, resetSessionCheckpointFlushes } from '../et/sessionStore';

async function deleteDatabase(): Promise<void> {
  await resetIndexedDbConnection();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('iwa-ssh');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function record(): EtSessionRecord {
  const now = Date.now();
  return {
    id: 'local-session', clientId: '1234567890123456', host: 'host', sshPort: 22, etPort: 2022,
    username: 'user', wrappedPasskey: new ArrayBuffer(4), passkeyIv: new Uint8Array(12),
    phase: 'detached', protocolVersion: 6, storageFormatVersion: 1, rxSequence: 0,
    txSequence: 0, txAcknowledged: 0, outboundBytes: 0, journalBytes: 0, journalTruncated: false, cols: 80, rows: 24,
    createdAt: now, updatedAt: now,
  };
}

beforeEach(deleteDatabase);
afterEach(async () => {
  resetSessionCheckpointFlushes();
  await deleteDatabase();
});

describe('IndexedDB v2 Eternal Terminal state', () => {
  it('migrates a v1 profile without recreating existing stores', async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('iwa-ssh', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('settings');
        const profiles = db.createObjectStore('profiles', { keyPath: 'id' });
        profiles.createIndex('by-last-connected', 'lastConnectedAt');
        db.createObjectStore('identities', { keyPath: 'id' });
        db.createObjectStore('knownHosts');
        profiles.put({ id: 'p', name: 'kept', host: 'h', port: 22, username: 'u' });
      };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
    expect((await listProfiles()).map((profile) => profile.name)).toEqual(['kept']);
    await saveEtSession(record());
    expect((await getEtSession('local-session'))?.protocolVersion).toBe(6);
  });

  it('stores one non-extractable device key', async () => {
    const first = await getEtDeviceKey();
    const second = await getEtDeviceKey();
    expect(first.extractable).toBe(false);
    const iv = new Uint8Array(12);
    const plaintext = new Uint8Array([1, 2, 3]);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, first, plaintext);
    expect([...new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, second, ciphertext))]).toEqual([1, 2, 3]);
  });

  it('rejects outbound sequence gaps without advancing the session', async () => {
    await saveEtSession(record());
    await expect(saveEtOutboundFrame({ sessionId: 'local-session', sequence: 2, bytes: new Uint8Array([1]), size: 1 })).rejects.toThrow('Non-contiguous');
    expect((await getEtSession('local-session'))?.txSequence).toBe(0);
  });

  it('checkpointEtInbound keeps the latest outbound sequence when the session hint is stale', async () => {
    await saveEtSession(record());
    await saveEtOutboundFrame({ sessionId: 'local-session', sequence: 1, bytes: new Uint8Array([1]), size: 1 });
    const staleHint = { ...(await getEtSession('local-session'))!, txSequence: 0 };
    const next = await checkpointEtInbound(
      { sessionId: 'local-session', sequence: 1, iv: new Uint8Array(12), ciphertext: new ArrayBuffer(4), size: 4 },
      'local-session',
      1,
      { sessionHint: staleHint, deferSessionPut: true },
    );
    expect(next).toMatchObject({ rxSequence: 1, txSequence: 1 });
  });

  it('checkpointEtOutput accepts consecutive sequences while session put is deferred', async () => {
    await saveEtSession(record());
    const hint = (await getEtSession('local-session'))!;
    await checkpointEtOutput('local-session', 1, new Uint8Array([1]), hint);
    await checkpointEtOutput('local-session', 2, new Uint8Array([2]), { ...hint, rxSequence: 1 });
    await flushEtSessionCheckpoint('local-session');
    expect(await getEtSession('local-session')).toMatchObject({ rxSequence: 2 });
  });

  it('deferred journal flush preserves outbound progress made during encryption', async () => {
    await saveEtSession(record());
    const hint = await getEtSession('local-session');
    const pending = checkpointEtOutput('local-session', 1, new Uint8Array([1, 2, 3]), hint!);
    await saveEtOutboundFrame({ sessionId: 'local-session', sequence: 1, bytes: new Uint8Array([9]), size: 1 });
    await pending;
    await flushEtSessionCheckpoint('local-session');
    expect(await getEtSession('local-session')).toMatchObject({ rxSequence: 1, txSequence: 1 });
    await expect(
      saveEtOutboundFrame({ sessionId: 'local-session', sequence: 2, bytes: new Uint8Array([2]), size: 1 }),
    ).resolves.toMatchObject({ txSequence: 2 });
  });

  it('prepareEtSessionForConnect clears orphaned recovery rows after a failed first connect', async () => {
    await saveEtSession(record());
    await saveEtOutboundFrame({ sessionId: 'local-session', sequence: 1, bytes: new Uint8Array([1]), size: 1 });
    const stale = await getEtSession('local-session');
    await saveEtSession({
      ...stale!,
      txSequence: 0,
      rxSequence: 0,
      outboundBytes: 0,
      journalBytes: 0,
    });
    const prepared = await prepareEtSessionForConnect('local-session');
    expect(prepared).toMatchObject({ txSequence: 0, rxSequence: 0, outboundBytes: 0, journalBytes: 0 });
    await expect(
      saveEtOutboundFrame({ sessionId: 'local-session', sequence: 1, bytes: new Uint8Array([2]), size: 1 }),
    ).resolves.toMatchObject({ txSequence: 1 });
  });
});
