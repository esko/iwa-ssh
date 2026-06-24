/**
 * Stage and sync OpenSSH known_hosts in nassh's indexeddb-fs.
 */

import { log } from '../debug/logger';
import { clearKnownHosts, listKnownHosts, saveKnownHost } from '../storage/indexedDb';
import type { KnownHost } from '../settings/types';
import {
  fingerprintFromOpensshLine,
  formatKnownHostTarget,
  knownHostLineMatchesTarget,
  knownHostLinesForTarget,
  parseKnownHostsLine,
} from './knownHostFormat';
import { upstreamImport } from './upstreamUrls';

type NasshFsModule = {
  getIndexeddbFileSystem: () => Promise<{
    createDirectory: (path: string) => Promise<void>;
    writeFile: (path: string, contents: ArrayBuffer) => Promise<void>;
    readFile: (path: string) => Promise<ArrayBuffer>;
  }>;
};

let fsModulePromise: Promise<NasshFsModule> | null = null;

async function loadNasshFs() {
  if (!fsModulePromise) {
    fsModulePromise = upstreamImport<NasshFsModule>('nassh/js/nassh_fs.js');
  }
  const { getIndexeddbFileSystem } = await fsModulePromise;
  return getIndexeddbFileSystem();
}

const KNOWN_HOSTS_PATH = '/.ssh/known_hosts';
const KNOWN_HOSTS2_PATH = '/.ssh/known_hosts2';

async function stageEmptyKnownHosts2(fs: Awaited<ReturnType<typeof loadNasshFs>>): Promise<void> {
  await fs.writeFile(KNOWN_HOSTS2_PATH, new TextEncoder().encode('').buffer);
}

/** Write trusted hosts (with opensshLine) into nassh FS before connect. */
export async function stageKnownHostsForNassh(): Promise<void> {
  const hosts = await listKnownHosts();
  const lines = hosts.map((entry) => entry.opensshLine?.trim()).filter((line): line is string => Boolean(line));

  const fs = await loadNasshFs();
  await fs.createDirectory('/.ssh');

  const content = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  await fs.writeFile(KNOWN_HOSTS_PATH, new TextEncoder().encode(content).buffer);
  await stageEmptyKnownHosts2(fs);

  if (lines.length === 0) {
    log.knownHosts.info('cleared nassh known_hosts (no trusted hosts)');
    return;
  }

  log.knownHosts.info('staged known_hosts for nassh', { lines: lines.length });
}

/** Empty nassh's ~/.ssh/known_hosts file (including entries not mirrored in app IndexedDB). */
export async function clearNasshKnownHostsFile(): Promise<void> {
  const fs = await loadNasshFs();
  await fs.createDirectory('/.ssh');
  await fs.writeFile(KNOWN_HOSTS_PATH, new TextEncoder().encode('').buffer);
  await stageEmptyKnownHosts2(fs);
  log.knownHosts.info('cleared nassh known_hosts file');
}

/** Wipe trusted host keys from app IndexedDB and nassh FS. */
export async function wipeTrustedHostKeys(): Promise<{ indexedDb: number }> {
  const indexedDb = await clearKnownHosts();
  await clearNasshKnownHostsFile();
  return { indexedDb };
}

async function readKnownHostsFile(): Promise<string> {
  const fs = await loadNasshFs();
  try {
    const buf = await fs.readFile(KNOWN_HOSTS_PATH);
    return new TextDecoder().decode(buf);
  } catch {
    return '';
  }
}

/**
 * After ssh adds a host key, read nassh known_hosts and persist matching lines to IndexedDB.
 */
export async function syncKnownHostsFromNassh(host: string, port: number): Promise<void> {
  const fileText = await readKnownHostsFile();
  if (!fileText.trim()) return;

  const matches = knownHostLinesForTarget(fileText, host, port);
  if (matches.length === 0) return;

  const latest = matches[matches.length - 1]!;
  const fingerprint = await fingerprintFromOpensshLine(latest.opensshLine);
  if (!fingerprint) return;

  const entry: KnownHost = {
    host,
    port,
    keyType: latest.keyType,
    fingerprint,
    opensshLine: latest.opensshLine,
    trustedAt: Date.now(),
  };

  await saveKnownHost(entry);
  log.knownHosts.info('synced known host from nassh', {
    host,
    port,
    keyType: latest.keyType,
    fingerprint,
  });
}

/**
 * Drop every known_hosts line that matches host:port from nassh FS.
 *
 * Used to clear a stale/offending key (e.g. after a fixture rebuild) so the next
 * connect gets a fresh unknown-host prompt instead of OpenSSH's hard
 * "REMOTE HOST IDENTIFICATION HAS CHANGED" failure. Returns the number of lines removed.
 */
export async function removeKnownHostLinesFromNassh(host: string, port: number): Promise<number> {
  const existing = await readKnownHostsFile();
  if (!existing.trim()) return 0;

  const kept: string[] = [];
  let removed = 0;
  for (const line of existing.split(/\r?\n/)) {
    const parsed = parseKnownHostsLine(line);
    if (parsed && knownHostLineMatchesTarget(parsed, host, port)) {
      removed += 1;
      continue;
    }
    kept.push(line);
  }

  if (removed === 0) return 0;

  const body = kept.join('\n').replace(/\n+$/, '');
  const content = body ? `${body}\n` : '';
  const fs = await loadNasshFs();
  await fs.createDirectory('/.ssh');
  await fs.writeFile(KNOWN_HOSTS_PATH, new TextEncoder().encode(content).buffer);
  log.knownHosts.info('removed stale known_hosts lines from nassh', {
    target: formatKnownHostTarget(host, port),
    removed,
  });
  return removed;
}

/** Merge a newly trusted line into nassh FS (append if missing). */
export async function appendKnownHostLineToNassh(opensshLine: string): Promise<void> {
  const parsed = parseKnownHostsLine(opensshLine);
  if (!parsed) return;

  const existing = await readKnownHostsFile();
  if (existing.split(/\r?\n/).some((line) => line.trim() === opensshLine.trim())) {
    return;
  }

  const fs = await loadNasshFs();
  await fs.createDirectory('/.ssh');
  const merged = existing.trim() ? `${existing.trim()}\n${opensshLine}\n` : `${opensshLine}\n`;
  await fs.writeFile(KNOWN_HOSTS_PATH, new TextEncoder().encode(merged).buffer);
  log.knownHosts.debug('appended known_hosts line', {
    markers: parsed.markers.map((m) => formatKnownHostTarget(m.host, m.port)).join(','),
  });
}
