#!/usr/bin/env node
/**
 * Derive Web Bundle ID from signing key and patch iwa/webbundle.config.ts.
 *
 * Usage:
 *   node scripts/update-webbundle-id.mjs
 *   node scripts/update-webbundle-id.mjs iwa/keys/encrypted_key.pem
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const configPath = resolve(repoRoot, 'iwa/webbundle.config.ts');

/** @type {import('../iwa/webbundle.config.ts').WebBundleConfig} */
let bundleConfig;

try {
  ({ bundleConfig } = await import('../iwa/webbundle.config.ts'));
} catch (error) {
  console.error('Failed to load iwa/webbundle.config.ts:', error);
  process.exit(1);
}

const keyArg = process.argv[2];
const keyPath = resolve(repoRoot, keyArg ?? bundleConfig.signingKeyPath);

if (!existsSync(keyPath)) {
  console.error(`Signing key not found: ${keyPath}`);
  console.error('Generate one with: npm run iwa:keygen');
  process.exit(1);
}

const result = spawnSync(
  'npx',
  ['--yes', '-p', 'wbn-sign', 'wbn-dump-id', '-k', keyPath],
  { cwd: repoRoot, encoding: 'utf8' },
);

if (result.status !== 0) {
  process.stderr.write(result.stderr ?? '');
  process.exit(result.status ?? 1);
}

const webBundleId = result.stdout.trim();
if (!webBundleId) {
  console.error('wbn-dump-id produced no output');
  process.exit(1);
}

const configText = readFileSync(configPath, 'utf8');
const updated = configText.replace(
  /webBundleId:\s*'[^']*'/,
  `webBundleId: '${webBundleId}'`,
);

if (updated === configText) {
  console.error('Could not find webBundleId field in iwa/webbundle.config.ts');
  process.exit(1);
}

writeFileSync(configPath, updated, 'utf8');

console.log(`Updated iwa/webbundle.config.ts`);
console.log(`  webBundleId: ${webBundleId}`);
console.log(`  origin: isolated-app://${webBundleId}/`);
