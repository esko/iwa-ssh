import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getKnownHost,
  clearKnownHosts,
  resetIndexedDbConnection,
  saveKnownHost,
} from '../storage/indexedDb';

async function deleteDatabase(): Promise<void> {
  await resetIndexedDbConnection();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('iwa-ssh');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

beforeEach(deleteDatabase);
afterEach(deleteDatabase);

describe('known-host fingerprint storage', () => {
  it('remembers the trusted fingerprint by host and port', async () => {
    await saveKnownHost({
      host: 'server.example',
      port: 2222,
      keyType: 'ssh-ed25519',
      fingerprint: 'SHA256:remembered',
      trustedAt: 123,
    });

    await expect(getKnownHost('server.example', 2222)).resolves.toMatchObject({
      keyType: 'ssh-ed25519',
      fingerprint: 'SHA256:remembered',
      trustedAt: 123,
    });
    await expect(getKnownHost('server.example', 22)).resolves.toBeUndefined();
  });

  it('clears every trusted host key', async () => {
    await saveKnownHost({
      host: 'a.example',
      port: 22,
      keyType: 'ssh-ed25519',
      fingerprint: 'SHA256:aaa',
      trustedAt: 1,
    });
    await saveKnownHost({
      host: 'b.example',
      port: 22,
      keyType: 'ssh-rsa',
      fingerprint: 'SHA256:bbb',
      trustedAt: 2,
    });

    await expect(clearKnownHosts()).resolves.toBe(2);
    await expect(getKnownHost('a.example', 22)).resolves.toBeUndefined();
    await expect(getKnownHost('b.example', 22)).resolves.toBeUndefined();
    await expect(clearKnownHosts()).resolves.toBe(0);
  });
});
