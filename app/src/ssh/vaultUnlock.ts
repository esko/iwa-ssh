/**
 * Interactive unlock for the credential vault, used on the SSH auth path before
 * a saved password is read or written. No-op when the vault is not locked (no
 * master password set, or already unlocked / auto-unlockable via the device key).
 */

import { credentialVault } from '../security/credentialVault';
import { showSecureInputPrompt } from './SecureInputPrompt';

const MAX_ATTEMPTS = 3;

/**
 * Ensure the vault is usable. Returns true when unlocked (or never locked),
 * false when the user cancelled or exhausted attempts — callers then fall back
 * to a normal password prompt rather than auto-fill.
 */
export async function ensureVaultUnlocked(): Promise<boolean> {
  if (!(await credentialVault.isLocked())) return true;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const message = attempt === 0
      ? 'Enter your master password to use saved passwords'
      : 'Incorrect master password — try again';
    const { value } = await showSecureInputPrompt(message, 256, false);
    if (value === null) return false; // cancelled
    if (await credentialVault.unlock(value)) return true;
  }
  return false;
}
