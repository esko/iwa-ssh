/**
 * Session-scoped cache for identity storage passphrases (never persisted).
 */

import { showSecureInputPrompt } from './SecureInputPrompt';

const cache = new Map<string, string>();

export function cacheIdentityPassphrase(identityId: string, passphrase: string): void {
  cache.set(identityId, passphrase);
}

export function getCachedIdentityPassphrase(identityId: string): string | undefined {
  return cache.get(identityId);
}

export function clearIdentityPassphrase(identityId: string): void {
  cache.delete(identityId);
}

export function clearAllIdentityPassphrases(): void {
  cache.clear();
}

/** Prompt for the storage passphrase used to decrypt an identity at connect time. */
export async function promptIdentityPassphrase(label: string): Promise<string | null> {
  return (await showSecureInputPrompt(`Enter passphrase for identity “${label}”`, 256, false)).value;
}
