import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetIndexedDbConnection } from '../storage/indexedDb';
import { credentialVault, VaultLockedError } from './credentialVault';
import { loadPassword, savePassword } from './savedPasswords';

async function deleteDatabase(): Promise<void> {
  credentialVault.clearCache();
  await resetIndexedDbConnection();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('iwa-ssh');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

const target = { username: 'ada', host: 'example.com', port: 22 };

beforeEach(deleteDatabase);
afterEach(deleteDatabase);

describe('credentialVault without a master password', () => {
  it('auto-unlocks and never reports locked', async () => {
    await savePassword(target, 's3cr3t');
    expect(await credentialVault.hasMasterPassword()).toBe(false);
    expect(await credentialVault.isLocked()).toBe(false);
    credentialVault.clearCache(); // simulate a cold start
    expect(await loadPassword(target)).toBe('s3cr3t');
  });
});

describe('setting a master password', () => {
  it('keeps saved passwords readable without re-encrypting them', async () => {
    await savePassword(target, 's3cr3t');
    await credentialVault.setMasterPassword('correct horse');
    expect(await credentialVault.hasMasterPassword()).toBe(true);
    // Remember-indefinitely: still auto-unlocks via the device copy.
    expect(await credentialVault.isLocked()).toBe(false);
    expect(await loadPassword(target)).toBe('s3cr3t');
  });
});

describe('lock / unlock', () => {
  it('locks after a master password is set, then unlocks with it', async () => {
    await savePassword(target, 's3cr3t');
    await credentialVault.setMasterPassword('correct horse');
    await credentialVault.lock();

    expect(await credentialVault.isLocked()).toBe(true);
    // Reads throw while locked.
    await expect(credentialVault.getDataKeyForRead()).rejects.toBeInstanceOf(VaultLockedError);

    expect(await credentialVault.unlock('wrong')).toBe(false);
    expect(await credentialVault.isLocked()).toBe(true);

    expect(await credentialVault.unlock('correct horse')).toBe(true);
    expect(await credentialVault.isLocked()).toBe(false);
    expect(await loadPassword(target)).toBe('s3cr3t');
  });

  it('survives a cold start while unlocked (device copy restored on unlock)', async () => {
    await savePassword(target, 's3cr3t');
    await credentialVault.setMasterPassword('correct horse');
    await credentialVault.lock();
    expect(await credentialVault.unlock('correct horse')).toBe(true);

    credentialVault.clearCache(); // cold start: in-memory DEK gone
    expect(await credentialVault.isLocked()).toBe(false); // device copy auto-unlocks
    expect(await loadPassword(target)).toBe('s3cr3t');
  });
});

describe('changeMasterPassword', () => {
  it('rejects a wrong current password and rotates on the right one', async () => {
    await savePassword(target, 's3cr3t');
    await credentialVault.setMasterPassword('first');

    expect(await credentialVault.changeMasterPassword('nope', 'second')).toBe(false);
    expect(await credentialVault.changeMasterPassword('first', 'second')).toBe(true);

    await credentialVault.lock();
    expect(await credentialVault.unlock('first')).toBe(false);
    expect(await credentialVault.unlock('second')).toBe(true);
    expect(await loadPassword(target)).toBe('s3cr3t');
  });
});

describe('removeMasterPassword', () => {
  it('verifies the password and reverts to device-only auto-unlock', async () => {
    await savePassword(target, 's3cr3t');
    await credentialVault.setMasterPassword('first');

    expect(await credentialVault.removeMasterPassword('nope')).toBe(false);
    expect(await credentialVault.removeMasterPassword('first')).toBe(true);

    expect(await credentialVault.hasMasterPassword()).toBe(false);
    await credentialVault.lock(); // no-op without a master password
    expect(await credentialVault.isLocked()).toBe(false);
    expect(await loadPassword(target)).toBe('s3cr3t');
  });
});
