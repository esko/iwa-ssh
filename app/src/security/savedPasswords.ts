/**
 * Opt-in SSH password storage, encrypted at rest by the credential vault.
 *
 * Passwords are sealed with the vault's data key (DEK) — see
 * {@link ../security/credentialVault}. Without a master password the DEK is
 * wrapped by the non-extractable device key (usable by anyone with the unlocked
 * app, same bar as the ET journal); with a master password set the DEK is also
 * recoverable only through it, and {@link credentialVault.lock} forces a prompt.
 * Saving is strictly opt-in (a checkbox on the password prompt) and a rejected
 * password is forgotten automatically. Records are keyed by `${username}@${host}:${port}`.
 *
 * When the vault is locked these calls throw {@link VaultLockedError}; callers in
 * the auth path unlock first via `ssh/vaultUnlock.ts`.
 */

import { credentialVault } from './credentialVault';
import {
  deleteSavedPasswordRecord,
  getSavedPasswordRecord,
  listSavedPasswordRecords,
  putSavedPassword,
} from '../storage/indexedDb';

export type CredentialTarget = { username: string; host: string; port: number };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Copy into a fresh ArrayBuffer-backed view so WebCrypto's BufferSource typing holds for IDB-read bytes. */
function owned(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

/** Stable storage key for a target. Host is lower-cased; username is case-kept. */
export function credentialKey(target: CredentialTarget): string {
  return `${target.username}@${target.host.toLowerCase()}:${target.port}`;
}

/** A password can only be saved/auto-filled when the target is fully addressable. */
export function canSavePassword(target: CredentialTarget): boolean {
  return Boolean(target.username) && Boolean(target.host) && Number.isFinite(target.port);
}

/** Encrypt and persist a password for `target`. No-op for empty input/targets. */
export async function savePassword(target: CredentialTarget, password: string): Promise<void> {
  if (!canSavePassword(target) || !password) return;
  const key = await credentialVault.getOrCreateDataKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(password));
  await putSavedPassword({
    credentialKey: credentialKey(target),
    username: target.username,
    host: target.host,
    port: target.port,
    iv,
    ciphertext,
    savedAt: Date.now(),
  });
}

/**
 * Return the saved password for `target`, or null when none is stored. A record
 * that fails to decrypt (e.g. the device key was reset) is treated as absent and
 * removed so the user is prompted cleanly instead of looping.
 */
export async function loadPassword(target: CredentialTarget): Promise<string | null> {
  if (!canSavePassword(target)) return null;
  const record = await getSavedPasswordRecord(credentialKey(target));
  if (!record) return null;
  const key = await credentialVault.getDataKeyForRead();
  if (!key) return null;
  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: owned(record.iv) }, key, record.ciphertext);
    return decoder.decode(plaintext);
  } catch {
    await deleteSavedPasswordRecord(credentialKey(target)).catch(() => undefined);
    return null;
  }
}

/** True when a stored password exists for `target` (does not decrypt it). */
export async function hasSavedPassword(target: CredentialTarget): Promise<boolean> {
  if (!canSavePassword(target)) return false;
  return Boolean(await getSavedPasswordRecord(credentialKey(target)));
}

/** Remove the saved password for `target` (called when a stored password is rejected). */
export async function forgetPassword(target: CredentialTarget): Promise<void> {
  await deleteSavedPasswordRecord(credentialKey(target)).catch(() => undefined);
}

export type SavedCredentialSummary = { credentialKey: string; username: string; host: string; port: number; savedAt: number };

/** Targets that have a saved password, for a future "manage saved passwords" UI. */
export async function listSavedCredentials(): Promise<SavedCredentialSummary[]> {
  const records = await listSavedPasswordRecords();
  return records
    .map(({ credentialKey: key, username, host, port, savedAt }) => ({ credentialKey: key, username, host, port, savedAt }))
    .sort((a, b) => b.savedAt - a.savedAt);
}
