#!/usr/bin/env node
/**
 * Bump the app version across every place it is duplicated, so an installed
 * IWA reliably picks up updates via Force update check (which only fires when
 * the manifest version increases).
 *
 * Usage:
 *   node scripts/bump-version.mjs            # patch bump (default)
 *   node scripts/bump-version.mjs patch
 *   node scripts/bump-version.mjs minor
 *   node scripts/bump-version.mjs major
 *   node scripts/bump-version.mjs 0.2.0      # explicit version
 *   node scripts/bump-version.mjs --dry-run  # preview without writing
 *
 * package.json is the source of truth for the current version.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const spec = args.find((a) => !a.startsWith('--')) ?? 'patch';

const pkgPath = join(ROOT, 'package.json');
const current = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(current ?? '')) {
  console.error(`package.json version is not plain semver: ${current}`);
  process.exit(1);
}

function nextVersion(from, how) {
  if (/^\d+\.\d+\.\d+$/.test(how)) return how;
  const [major, minor, patch] = from.split('.').map(Number);
  if (how === 'major') return `${major + 1}.0.0`;
  if (how === 'minor') return `${major}.${minor + 1}.0`;
  if (how === 'patch') return `${major}.${minor}.${patch + 1}`;
  console.error(`Unknown bump "${how}". Use major | minor | patch | X.Y.Z`);
  process.exit(1);
}

const next = nextVersion(current, spec);
if (next === current) {
  console.error(`Target version ${next} equals current — nothing to bump.`);
  process.exit(1);
}

// Each target file plus the exact string to replace, so we fail loudly if the
// shape drifts instead of silently leaving a file behind.
const targets = [
  { path: 'package.json', find: `"version": "${current}"`, replace: `"version": "${next}"` },
  { path: 'app/public/manifest.webmanifest', find: `"version": "${current}"`, replace: `"version": "${next}"` },
  { path: 'app/public/.well-known/manifest.webmanifest', find: `"version": "${current}"`, replace: `"version": "${next}"` },
];

console.log(`Bump ${current} -> ${next}${dryRun ? ' (dry run)' : ''}\n`);

let failed = false;
const prepared = [];
for (const { path, find, replace, expected = 1 } of targets) {
  const full = join(ROOT, path);
  const text = readFileSync(full, 'utf8');
  const occurrences = text.split(find).length - 1;
  if (occurrences !== expected) {
    console.error(`  ✗ ${path}: expected ${expected} occurrence(s) of ${JSON.stringify(find)}, found ${occurrences}`);
    failed = true;
    continue;
  }
  prepared.push({ full, text: text.replaceAll(find, replace) });
  console.log(`  ✓ ${path}`);
}

const lockPath = join(ROOT, 'package-lock.json');
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
if (lock.version !== current || lock.packages?.['']?.version !== current) {
  console.error(`  ✗ package-lock.json: root versions must both equal ${current}`);
  failed = true;
} else {
  lock.version = next;
  lock.packages[''].version = next;
  console.log('  ✓ package-lock.json');
}

if (failed) {
  console.error('\nNo files changed — fix the drift above and retry.');
  process.exit(1);
}

if (!dryRun) {
  for (const { full, text } of prepared) writeFileSync(full, text);
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

console.log(
  dryRun
    ? `\nDry run only. Re-run without --dry-run to write ${next}.`
    : `\nBumped to ${next}. Restart npm run dev, then Force update check in chrome://web-app-internals.`,
);
