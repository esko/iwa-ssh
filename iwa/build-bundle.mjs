#!/usr/bin/env node
/**
 * Build production dist/ and package an IWA Signed Web Bundle.
 *
 * Usage: npm run bundle:iwa
 *
 * Requires (for signing): wbn, wbn-sign — fetched via npx if not installed.
 * Signing key: iwa/keys/encrypted_key.pem (see docs/IWA_DEV_SETUP.md)
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
  console.error(
    'Failed to load iwa/webbundle.config.ts — use Node 22+ with --experimental-strip-types,',
  );
  console.error('or run the manual steps printed below.\n', error);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: false,
    ...opts,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function npx(cmd, args) {
  run('npx', ['--yes', cmd, ...args]);
}

console.log('→ Building production assets (npm run build)…');
run('npm', ['run', 'build']);

const distDir = resolve(repoRoot, bundleConfig.distDir);
if (!existsSync(distDir)) {
  console.error(`dist/ not found at ${distDir}`);
  process.exit(1);
}

const unsignedPath = resolve(repoRoot, bundleConfig.unsignedBundle);
const signedPath = resolve(repoRoot, bundleConfig.signedBundle);
const keyPath = resolve(repoRoot, bundleConfig.signingKeyPath);

let baseURL;
if (bundleConfig.webBundleId.startsWith('PLACEHOLDER')) {
  baseURL = 'isolated-app://dev-placeholder/';
  console.warn(
    '\n⚠ webBundleId is still a placeholder in iwa/webbundle.config.ts.',
  );
  console.warn(
    '  After generating a key, run: npx wbn-dump-id -iwa iwa/keys/encrypted_key.pem',
  );
  console.warn('  and update webBundleId + re-run bundle:iwa for a valid IWA origin.\n');
} else {
  baseURL = `isolated-app://${bundleConfig.webBundleId}/`;
}

console.log(`→ Creating unsigned web bundle → ${bundleConfig.unsignedBundle}`);
npx('wbn', [
  '--dir',
  bundleConfig.distDir,
  '--baseURL',
  baseURL,
  '--output',
  bundleConfig.unsignedBundle,
]);

if (!existsSync(keyPath)) {
  console.log(`
Unsigned bundle ready: ${bundleConfig.unsignedBundle}

Signing key not found at ${bundleConfig.signingKeyPath}

Next steps — generate key and sign:
  mkdir -p iwa/keys
  openssl genpkey -algorithm Ed25519 -out iwa/keys/private_key.pem
  openssl pkcs8 -in iwa/keys/private_key.pem -topk8 -out iwa/keys/encrypted_key.pem
  rm iwa/keys/private_key.pem
  npx wbn-dump-id -iwa iwa/keys/encrypted_key.pem   # update webBundleId in webbundle.config.ts
  WEB_BUNDLE_SIGNING_PASSPHRASE='…' npm run bundle:iwa

Install: chrome://web-app-internals → Install IWA from Signed Web Bundle
(Dev without signing: use Dev Mode Proxy — see docs/IWA_DEV_SETUP.md)
`);
  process.exit(0);
}

console.log(`→ Signing bundle → ${bundleConfig.signedBundle}`);
const signArgs = ['sign', bundleConfig.unsignedBundle, bundleConfig.signingKeyPath, '-o', bundleConfig.signedBundle];
if (process.env.WEB_BUNDLE_SIGNING_PASSPHRASE) {
  signArgs.push('--password-env', 'WEB_BUNDLE_SIGNING_PASSPHRASE');
}
npx('wbn-sign', signArgs);

console.log(`
✓ Signed bundle: ${bundleConfig.signedBundle}
  Version: ${bundleConfig.version}

Install:
  1. chrome://flags → enable IWA dev mode → restart
  2. chrome://web-app-internals → Install IWA from Signed Web Bundle
  3. Select ${bundleConfig.signedBundle}

Show bundle info:
  npx wbn-sign info ${bundleConfig.signedBundle}
`);
