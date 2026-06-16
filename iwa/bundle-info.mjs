#!/usr/bin/env node
/**
 * Show integrity-block info for a signed IWA bundle.
 *
 * Usage: npm run bundle:iwa:info
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

/** @type {import('./webbundle.config.ts').WebBundleConfig} */
let bundleConfig;

try {
  ({ bundleConfig } = await import('./webbundle.config.ts'));
} catch (error) {
  console.error('Failed to load iwa/webbundle.config.ts:', error);
  process.exit(1);
}

const signedPath = resolve(repoRoot, bundleConfig.signedBundle);

if (!existsSync(signedPath)) {
  console.error(`Signed bundle not found: ${bundleConfig.signedBundle}`);
  console.error('Build and sign first: WEB_BUNDLE_SIGNING_PASSPHRASE=… npm run bundle:iwa');
  process.exit(1);
}

console.log(`Bundle: ${bundleConfig.signedBundle}`);
console.log(`Config webBundleId: ${bundleConfig.webBundleId}`);
console.log(`Version: ${bundleConfig.version}\n`);

const result = spawnSync(
  'npx',
  ['--yes', '-p', 'wbn-sign', 'wbn-sign', 'info', bundleConfig.signedBundle],
  { cwd: repoRoot, stdio: 'inherit' },
);

process.exit(result.status ?? 1);
