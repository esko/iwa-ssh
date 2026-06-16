#!/usr/bin/env node
/**
 * Derive Web Bundle ID from signing key and patch iwa/webbundle.config.ts.
 *
 * Prefers iwa/keys/public_key.pem (no passphrase). For encrypted private keys only,
 * set WEB_BUNDLE_SIGNING_PASSPHRASE before running.
 *
 * Usage:
 *   npm run iwa:update-id
 *   node scripts/update-webbundle-id.mjs iwa/keys/public_key.pem
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const configPath = resolve(repoRoot, 'iwa/webbundle.config.ts');

/** Base32 Web Bundle IDs (lowercase a-z, digits 2-7). */
const WEB_BUNDLE_ID_RE = /^[a-z2-7]{32,64}$/;

/** @type {import('../iwa/webbundle.config.ts').WebBundleConfig} */
let bundleConfig;

try {
  ({ bundleConfig } = await import('../iwa/webbundle.config.ts'));
} catch (error) {
  console.error('Failed to load iwa/webbundle.config.ts:', error);
  process.exit(1);
}

export function isValidWebBundleId(value) {
  return WEB_BUNDLE_ID_RE.test(value);
}

function resolveKeyPath(explicitPath) {
  if (explicitPath) {
    return resolve(repoRoot, explicitPath);
  }

  const publicKey = resolve(repoRoot, 'iwa/keys/public_key.pem');
  if (existsSync(publicKey)) {
    return publicKey;
  }

  return resolve(repoRoot, bundleConfig.signingKeyPath);
}

function dumpWebBundleId(keyPath) {
  const isPrivateKey = !keyPath.endsWith('.pub') && !keyPath.endsWith('public_key.pem');
  const passphrase = process.env.WEB_BUNDLE_SIGNING_PASSPHRASE;

  if (isPrivateKey && !passphrase) {
    console.error(
      'Encrypted signing key requires WEB_BUNDLE_SIGNING_PASSPHRASE, or export a public key:',
    );
    console.error('  openssl pkey -in iwa/keys/encrypted_key.pem -pubout -out iwa/keys/public_key.pem');
    console.error('  npm run iwa:update-id iwa/keys/public_key.pem');
    process.exit(1);
  }

  const spawnOpts = { cwd: repoRoot, encoding: 'utf8' };
  if (passphrase) {
    spawnOpts.input = `${passphrase}\n`;
  }

  const result = spawnSync(
    'npx',
    ['--yes', '-p', 'wbn-sign', 'wbn-dump-id', '-k', keyPath],
    spawnOpts,
  );

  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? '');
    process.exit(result.status ?? 1);
  }

  const webBundleId = result.stdout.trim();
  if (!isValidWebBundleId(webBundleId)) {
    console.error('wbn-dump-id did not return a valid Web Bundle ID.');
    if (result.stdout) {
      console.error(`stdout: ${result.stdout.trim()}`);
    }
    if (result.stderr) {
      console.error(`stderr: ${result.stderr.trim()}`);
    }
    if (/passphrase/i.test(`${result.stdout}\n${result.stderr}`)) {
      console.error('Hint: set WEB_BUNDLE_SIGNING_PASSPHRASE or use iwa/keys/public_key.pem');
    }
    process.exit(1);
  }

  return webBundleId;
}

const keyArg = process.argv[2];
const keyPath = resolveKeyPath(keyArg);

if (!existsSync(keyPath)) {
  console.error(`Signing key not found: ${keyPath}`);
  console.error('Generate one with: npm run iwa:keygen');
  process.exit(1);
}

const webBundleId = dumpWebBundleId(keyPath);

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

console.log('Updated iwa/webbundle.config.ts');
console.log(`  webBundleId: ${webBundleId}`);
console.log(`  origin: isolated-app://${webBundleId}/`);
