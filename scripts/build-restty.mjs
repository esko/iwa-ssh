#!/usr/bin/env node
/**
 * Vendor the prebuilt @eslzzyl/restty into vendor/restty/.
 *
 * The fork does NOT commit dist/ to git (it's published to npm), so we vendor
 * the published package's prebuilt dist (WASM is base64-embedded — no Zig, no
 * runtime fetch). The vendored manifest keeps only the browser runtime dep
 * `text-shaper` and drops restty's Node-only `ws` + `zigpty` (a native addon)
 * so `npm install` stays clean.
 *
 * Pinned to a specific version + the corresponding upstream commit for
 * provenance. A full source build (Zig 0.15.2 + the ghostty submodule + Vite)
 * is the documented follow-up — see docs/UPSTREAM_SYNC.md.
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, cpSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = '@eslzzyl/restty';
const VERSION = '0.1.37';
const PINNED_COMMIT = 'cb79ed540f76a3b38da05cf8dae8fc3d58ee67e0'; // Eslzzyl/restty@main
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'vendor', 'restty');

const REQUIRED = ['dist/xterm.esm.js', 'dist/xterm.js', 'dist/restty.esm.js', 'dist/index.d.ts', 'dist/xterm.d.ts'];

const tmp = mkdtempSync(join(tmpdir(), 'restty-vendor-'));
try {
  console.log(`Fetching ${PKG}@${VERSION} from npm…`);
  execSync(`npm pack ${PKG}@${VERSION} --silent`, { cwd: tmp, stdio: 'inherit' });
  execSync(`tar -xzf eslzzyl-restty-${VERSION}.tgz`, { cwd: tmp, stdio: 'inherit' });
  const src = join(tmp, 'package');

  rmSync(VENDOR, { recursive: true, force: true });
  mkdirSync(VENDOR, { recursive: true });
  cpSync(join(src, 'dist'), join(VENDOR, 'dist'), { recursive: true });
  for (const f of ['README.md', 'LICENSE']) {
    if (existsSync(join(src, f))) cpSync(join(src, f), join(VENDOR, f));
  }

  const upstream = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
  const vendored = {
    name: upstream.name,
    version: upstream.version,
    description: upstream.description,
    type: 'module',
    license: upstream.license,
    exports: upstream.exports,
    files: ['dist', 'README.md', 'LICENSE'],
    // Browser-only: keep text-shaper; drop Node-only ws/zigpty (native addon).
    dependencies: { 'text-shaper': upstream.dependencies['text-shaper'] },
    resttyVendor: { source: `${PKG}@${VERSION}`, commit: PINNED_COMMIT },
  };
  writeFileSync(join(VENDOR, 'package.json'), `${JSON.stringify(vendored, null, 2)}\n`);

  const missing = REQUIRED.filter((r) => !existsSync(join(VENDOR, r)));
  if (missing.length) {
    console.error('✗ Missing required entrypoints:', missing.join(', '));
    process.exit(1);
  }

  console.log(`\n✓ Vendored ${PKG}@${VERSION} (commit ${PINNED_COMMIT}) → vendor/restty`);
  console.log(`  text-shaper@${vendored.dependencies['text-shaper']} kept; ws + zigpty dropped`);
  console.log(`  entrypoints: ${REQUIRED.join(', ')}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
