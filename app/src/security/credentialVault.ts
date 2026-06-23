/**
 * Credential vault: the key hierarchy that protects saved SSH passwords.
 *
 * A single random 32-byte **data key (DEK)** encrypts every saved password
 * ({@link ../security/savedPasswords}). The DEK is never stored in the clear —
 * it is kept as two wrapped copies in `vaultMeta`:
 *
 *  - `dek-device` — sealed with the non-extractable device key. Its presence is
 *    what makes the vault auto-unlock silently; deleting it is "lock".
 *  - `dek-master` — sealed with a PBKDF2 key derived from the user's master
 *    password. Present only when a master password is set; it is the durable
 *    copy and the only way back in after locking.
 *
 * Because the DEK itself never changes, setting / changing / removing the master
 * password only rewraps it — saved passwords are never re-encrypted. The user
 * chose "remember indefinitely": after the master password is set the vault keeps
 * the `dek-device` copy, so it never prompts again until {@link lock} is called.
 *
 * This module is DOM-free. Interactive unlocking lives in `ssh/vaultUnlock.ts`.
 */

import {
  deleteVaultKeyRecord,
  getEtDeviceKey,
  getVaultKeyRecord,
  putVaultKeyRecord,
  type VaultKeyRecord,
} from '../storage/indexedDb';

const DEK_BYTES = 32;
const IV_BYTES = 12;
const SALT_BYTES = 16;
const PBKDF2_ITERATIONS = 310_000;
const DEVICE_ID = 'dek-device';
const MASTER_ID = 'dek-master';

/** Thrown when a read needs the DEK but the vault is locked (master set, no device copy). */
export class VaultLockedError extends Error {
  constructor() {
    super('The saved-password vault is locked.');
    this.name = 'VaultLockedError';
  }
}

function owned(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

function subtle(): SubtleCrypto {
  if (!crypto?.subtle) throw new Error('Web Crypto is unavailable in this context.');
  return crypto.subtle;
}

async function deriveMasterKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await subtle().importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', salt: owned(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function sealWithDevice(dek: Uint8Array): Promise<VaultKeyRecord> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await subtle().encrypt({ name: 'AES-GCM', iv }, await getEtDeviceKey(), owned(dek));
  return { id: DEVICE_ID, iv, ciphertext };
}

async function sealWithMaster(dek: Uint8Array, password: string): Promise<VaultKeyRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveMasterKey(password, salt);
  const ciphertext = await subtle().encrypt({ name: 'AES-GCM', iv }, key, owned(dek));
  return { id: MASTER_ID, salt, iv, ciphertext };
}

/**
 * The credential vault. A process-wide singleton: the unlocked DEK is cached in
 * memory so the rest of the app shares one lock state.
 */
class CredentialVault {
  private dek: Uint8Array | null = null;

  /** True once a master password has been set (a `dek-master` record exists). */
  async hasMasterPassword(): Promise<boolean> {
    return Boolean(await getVaultKeyRecord(MASTER_ID));
  }

  /** Locked = a master password is set but there is no in-memory DEK and no device copy. */
  async isLocked(): Promise<boolean> {
    if (this.dek) return false;
    if (await getVaultKeyRecord(DEVICE_ID)) return false;
    return this.hasMasterPassword();
  }

  /** Resolve the raw DEK, optionally minting one. Throws {@link VaultLockedError} when locked. */
  private async resolveDek(create: boolean): Promise<Uint8Array | null> {
    if (this.dek) return this.dek;
    const deviceCopy = await getVaultKeyRecord(DEVICE_ID);
    if (deviceCopy) {
      const bytes = new Uint8Array(
        await subtle().decrypt({ name: 'AES-GCM', iv: owned(deviceCopy.iv) }, await getEtDeviceKey(), deviceCopy.ciphertext),
      );
      this.dek = bytes;
      return bytes;
    }
    if (await getVaultKeyRecord(MASTER_ID)) throw new VaultLockedError();
    if (!create) return null;
    const bytes = crypto.getRandomValues(new Uint8Array(DEK_BYTES));
    await putVaultKeyRecord(await sealWithDevice(bytes));
    this.dek = bytes;
    return bytes;
  }

  private async importDataKey(dek: Uint8Array): Promise<CryptoKey> {
    return subtle().importKey('raw', owned(dek), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  /** Verify a master password against the stored record and return the DEK, or null when wrong/unset. */
  private async unwrapWithMaster(password: string): Promise<Uint8Array | null> {
    const master = await getVaultKeyRecord(MASTER_ID);
    if (!master?.salt) return null;
    try {
      return new Uint8Array(
        await subtle().decrypt({ name: 'AES-GCM', iv: owned(master.iv) }, await deriveMasterKey(password, master.salt), master.ciphertext),
      );
    } catch {
      return null;
    }
  }

  /** DEK for decryption, or null when no DEK exists yet. Throws when locked. */
  async getDataKeyForRead(): Promise<CryptoKey | null> {
    const dek = await this.resolveDek(false);
    return dek ? this.importDataKey(dek) : null;
  }

  /** DEK for encryption, minting one on first use. Throws when locked. */
  async getOrCreateDataKey(): Promise<CryptoKey> {
    const dek = await this.resolveDek(true);
    if (!dek) throw new VaultLockedError();
    return this.importDataKey(dek);
  }

  /** Set the first master password (or re-wrap under a new one once unlocked). */
  async setMasterPassword(password: string): Promise<void> {
    if (!password) throw new Error('A master password is required.');
    const dek = await this.resolveDek(true);
    if (!dek) throw new VaultLockedError();
    await putVaultKeyRecord(await sealWithMaster(dek, password));
  }

  /** Verify the current password and rewrap the DEK under a new one. Returns false on a wrong current password. */
  async changeMasterPassword(current: string, next: string): Promise<boolean> {
    if (!next) throw new Error('A master password is required.');
    const dek = await this.unwrapWithMaster(current);
    if (!dek) return false;
    this.dek = dek;
    await putVaultKeyRecord(await sealWithMaster(dek, next));
    return true;
  }

  /**
   * Remove master-password protection after verifying it. The DEK stays usable
   * via the device copy (which is re-created if it was locked away).
   */
  async removeMasterPassword(password: string): Promise<boolean> {
    if (!(await getVaultKeyRecord(MASTER_ID))) return true;
    const dek = await this.unwrapWithMaster(password);
    if (!dek) return false;
    this.dek = dek;
    await putVaultKeyRecord(await sealWithDevice(dek));
    await deleteVaultKeyRecord(MASTER_ID);
    return true;
  }

  /** Unlock with the master password: cache the DEK and restore the device copy. No-op success when not locked. */
  async unlock(password: string): Promise<boolean> {
    if (!(await this.isLocked())) return true;
    const dek = await this.unwrapWithMaster(password);
    if (!dek) return false;
    this.dek = dek;
    await putVaultKeyRecord(await sealWithDevice(dek)); // remember indefinitely until the next lock
    return true;
  }

  /** Lock the vault: drop the in-memory DEK and the device copy so the master password is required again. */
  async lock(): Promise<void> {
    this.dek = null;
    if (await this.hasMasterPassword()) await deleteVaultKeyRecord(DEVICE_ID);
  }

  /** Drop only the in-memory DEK (test isolation / device-key reset). */
  clearCache(): void {
    this.dek = null;
  }
}

export const credentialVault = new CredentialVault();
