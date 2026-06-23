import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSavedPasswordRecord, resetIndexedDbConnection } from '../storage/indexedDb';
import { credentialVault } from './credentialVault';
import {
  canSavePassword,
  credentialKey,
  forgetPassword,
  hasSavedPassword,
  listSavedCredentials,
  loadPassword,
  savePassword,
} from './savedPasswords';

async function deleteDatabase(): Promise<void> {
  credentialVault.clearCache();
  await resetIndexedDbConnection();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('iwa-ssh');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

const target = { username: 'ada', host: 'Example.COM', port: 22 };

beforeEach(deleteDatabase);
afterEach(deleteDatabase);

describe('credentialKey', () => {
  it('lower-cases the host but keeps the username case', () => {
    expect(credentialKey(target)).toBe('ada@example.com:22');
  });
});

describe('canSavePassword', () => {
  it('requires a username, host, and finite port', () => {
    expect(canSavePassword(target)).toBe(true);
    expect(canSavePassword({ username: '', host: 'h', port: 22 })).toBe(false);
    expect(canSavePassword({ username: 'u', host: '', port: 22 })).toBe(false);
    expect(canSavePassword({ username: 'u', host: 'h', port: Number.NaN })).toBe(false);
  });
});

describe('savePassword / loadPassword', () => {
  it('round-trips a password through device-key encryption', async () => {
    await savePassword(target, 's3cr3t');
    expect(await loadPassword(target)).toBe('s3cr3t');
    expect(await loadPassword({ username: 'ada', host: 'example.com', port: 22 })).toBe('s3cr3t');
  });

  it('stores the password encrypted, never in plaintext', async () => {
    await savePassword(target, 's3cr3t');
    const record = await getSavedPasswordRecord(credentialKey(target));
    expect(record).toBeDefined();
    const stored = new Uint8Array(record!.ciphertext);
    const plaintext = new TextEncoder().encode('s3cr3t');
    // Ciphertext must not contain the plaintext bytes verbatim.
    expect([...stored].join(',')).not.toContain([...plaintext].join(','));
  });

  it('returns null and is a no-op for empty input or unaddressable targets', async () => {
    await savePassword(target, '');
    expect(await hasSavedPassword(target)).toBe(false);
    await savePassword({ username: '', host: 'h', port: 22 }, 'x');
    expect(await loadPassword({ username: '', host: 'h', port: 22 })).toBeNull();
  });

  it('returns null when nothing is stored', async () => {
    expect(await loadPassword(target)).toBeNull();
  });
});

describe('forgetPassword', () => {
  it('removes a stored password', async () => {
    await savePassword(target, 's3cr3t');
    expect(await hasSavedPassword(target)).toBe(true);
    await forgetPassword(target);
    expect(await hasSavedPassword(target)).toBe(false);
    expect(await loadPassword(target)).toBeNull();
  });
});

describe('listSavedCredentials', () => {
  it('summarizes saved targets without exposing the password', async () => {
    await savePassword(target, 's3cr3t');
    await savePassword({ username: 'bob', host: 'b.example', port: 2222 }, 'pw');
    const summaries = await listSavedCredentials();
    expect(summaries).toHaveLength(2);
    expect(summaries.every((s) => !('ciphertext' in s) && !('password' in s))).toBe(true);
    expect(summaries.map((s) => s.credentialKey)).toContain('ada@example.com:22');
  });
});
