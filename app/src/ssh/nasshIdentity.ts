/**
 * Stage Gosh identities into nassh's indexeddb-fs for -i/.ssh/identity/… usage.
 */

import { log } from '../debug/logger';
import { listIdentities } from '../storage/indexedDb';
import type { Identity } from '../settings/types';
import { identityHasPrivateKey, resolveIdentityPrivateKeyPem } from './identitySecrets';
import { upstreamImport } from './upstreamUrls';

type NasshFsModule = {
  getIndexeddbFileSystem: () => Promise<{
    createDirectory: (path: string) => Promise<void>;
    writeFile: (path: string, contents: ArrayBuffer) => Promise<void>;
  }>;
};

let fsModulePromise: Promise<NasshFsModule> | null = null;

async function loadNasshFs(): Promise<NasshFsModule> {
  if (!fsModulePromise) {
    fsModulePromise = upstreamImport<NasshFsModule>('nassh/js/nassh_fs.js');
  }
  return fsModulePromise;
}

async function getIdentityById(identityId: string): Promise<Identity | undefined> {
  const identities = await listIdentities();
  return identities.find((entry) => entry.id === identityId);
}

const NEWLINE = 0x0a;

/**
 * OpenSSH refuses to load a private key file that lacks a trailing newline
 * ("invalid format" / "error in libcrypto"). Stored PEMs are trimmed, so re-add it.
 */
function ensureTrailingNewline(pem: ArrayBuffer): ArrayBuffer {
  const bytes = new Uint8Array(pem);
  if (bytes.length > 0 && bytes[bytes.length - 1] === NEWLINE) {
    return pem;
  }
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes, 0);
  out[bytes.length] = NEWLINE;
  return out.buffer;
}

/** Filename placed under /.ssh/identity/ for upstream ssh -i. */
export function nasshIdentityFilename(identityId: string): string {
  return `gosh-${identityId}`;
}

/**
 * Copy a stored private key PEM into nassh's virtual filesystem.
 * Returns the identity filename for connectTo params, or undefined when unavailable.
 */
export async function stageIdentityForNassh(identityId: string): Promise<string | undefined> {
  const identity = await getIdentityById(identityId);
  if (!identity) {
    log.ssh.warn('identity not found', { identityId });
    return undefined;
  }

  if (!identityHasPrivateKey(identity)) {
    log.ssh.warn('identity has no private key material', { identityId, label: identity.label });
    return undefined;
  }

  let pemBytes: ArrayBuffer;
  try {
    const resolved = await resolveIdentityPrivateKeyPem(identity);
    if (!resolved) {
      log.ssh.warn('identity passphrase not provided', { identityId, label: identity.label });
      return undefined;
    }
    pemBytes = resolved;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.ssh.error('failed to decrypt identity', { identityId, message });
    throw error;
  }

  const filename = nasshIdentityFilename(identityId);
  const { getIndexeddbFileSystem } = await loadNasshFs();
  const fileSystem = await getIndexeddbFileSystem();

  await fileSystem.createDirectory('/.ssh');
  await fileSystem.createDirectory('/.ssh/identity');
  await fileSystem.writeFile(`/.ssh/identity/${filename}`, ensureTrailingNewline(pemBytes));

  if (identity.publicKey) {
    const pubBytes = new TextEncoder().encode(`${identity.publicKey.trim()}\n`);
    await fileSystem.writeFile(`/.ssh/identity/${filename}.pub`, pubBytes.buffer);
  }

  log.ssh.info('staged identity for nassh', { identityId, filename, label: identity.label });
  return filename;
}
