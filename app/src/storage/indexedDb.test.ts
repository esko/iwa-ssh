import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getEtDeviceKey,
  getEtSession,
  listProfiles,
  resetIndexedDbConnection,
  saveEtOutboundFrame,
  saveEtSession,
  type EtSessionRecord,
} from './indexedDb';

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
afterEach(deleteDatabase);

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
});
