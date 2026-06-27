#!/usr/bin/env node
/**
 * Phase 1: copy upstream libapps wassh runtime + OpenSSH WASM plugin into app/upstream/.
 *
 * Preserves libapps-relative paths so ES module imports in worker.js resolve under /upstream/.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchWasshTerminalPixelSize } from './wassh-terminal-size-patch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LIBAPPS = path.join(REPO_ROOT, 'upstream/libapps');
const OUT_DIR = path.join(REPO_ROOT, 'app/upstream');
const PLUGIN_BIN = path.join(LIBAPPS, 'nassh/bin/plugin');
const PLUGIN_SRC = path.join(LIBAPPS, 'nassh/plugin');

/** @type {Array<{dest: string, bytes: number, source: string}>} */
const manifest = [];

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function copyFile(src, dest) {
  await ensureDir(path.dirname(dest));
  await fsp.copyFile(src, dest);
  const { size } = await fsp.stat(dest);
  manifest.push({
    dest: path.relative(OUT_DIR, dest),
    bytes: size,
    source: path.relative(REPO_ROOT, src),
  });
}

async function copyTree(srcRoot, destRoot, { filter } = {}) {
  if (!exists(srcRoot)) {
    return 0;
  }
  let count = 0;
  const entries = await fsp.readdir(srcRoot, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(srcRoot, entry.name);
    const dest = path.join(destRoot, entry.name);
    if (entry.isDirectory()) {
      count += await copyTree(src, dest, { filter });
    } else if (!filter || filter(src)) {
      await copyFile(src, dest);
      count += 1;
    }
  }
  return count;
}

function tryFetchPlugin() {
  if (!exists(LIBAPPS)) {
    return {
      ok: false,
      reason: `upstream/libapps not found — run: git submodule update --init upstream/libapps`,
    };
  }
  if (!exists(PLUGIN_BIN)) {
    return {
      ok: false,
      reason: `plugin downloader missing at ${path.relative(REPO_ROOT, PLUGIN_BIN)}`,
    };
  }

  console.log(`Running ${path.relative(REPO_ROOT, PLUGIN_BIN)} …`);
  const result = spawnSync(PLUGIN_BIN, [], {
    cwd: path.join(LIBAPPS, 'nassh'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    return {
      ok: false,
      reason: `bin/plugin exited ${result.status}${detail ? `: ${detail}` : ''}`,
    };
  }

  if (!exists(PLUGIN_SRC)) {
    return {
      ok: false,
      reason: 'bin/plugin succeeded but nassh/plugin/ is still missing',
    };
  }

  const defaultWasm = path.join(PLUGIN_SRC, 'wasm/ssh.wasm');
  if (!exists(defaultWasm)) {
    return {
      ok: false,
      reason: `default OpenSSH plugin missing at ${path.relative(REPO_ROOT, defaultWasm)} (not wasm-openssh-* alone)`,
    };
  }

  return { ok: true };
}

async function writeStub(reason) {
  await ensureDir(OUT_DIR);
  const readme = `# Upstream assets placeholder

Phase 1 fetch did not complete. ${reason}

## TODO

1. Initialize submodule: \`git submodule update --init upstream/libapps\`
2. Fetch plugin: \`cd upstream/libapps/nassh && ./bin/plugin\`
3. Copy assets: \`npm run fetch-assets\`

Expected layout after a successful fetch:

\`\`\`text
app/upstream/
  wassh/js/worker.js
  wasi-js-bindings/index.js
  wasi-js-bindings/js/...
  nassh/js/nassh_command_instance.js
  libdot/index.js
  hterm/index.js
  plugin/wasm/ssh.wasm
  plugin/wasm/mosh-client.wasm
  plugin/wasm-openssh-8.6/ssh.wasm
  manifest.json
\`\`\`
`;
  await fsp.writeFile(path.join(OUT_DIR, 'README.md'), readme, 'utf8');
  for (const dir of [
    'wassh/js',
    'wasi-js-bindings/js',
    'plugin/wasm',
    'plugin/wasm-openssh-8.6',
    'nassh/js',
    'libdot/js',
    'hterm/js',
  ]) {
    await ensureDir(path.join(OUT_DIR, dir));
    await fsp.writeFile(
      path.join(OUT_DIR, dir, '.gitkeep'),
      '# TODO: populated by npm run fetch-assets\n',
      'utf8',
    );
  }
  manifest.push({
    dest: 'README.md',
    bytes: Buffer.byteLength(readme),
    source: '(stub)',
  });
}

async function copyWasshJs() {
  const srcDir = path.join(LIBAPPS, 'wassh/js');
  const destDir = path.join(OUT_DIR, 'wassh/js');
  return copyTree(srcDir, destDir, {
    filter: (p) => p.endsWith('.js'),
  });
}

async function copyWasiBindings() {
  const indexSrc = path.join(LIBAPPS, 'wasi-js-bindings/index.js');
  if (!exists(indexSrc)) {
    throw new Error('missing wasi-js-bindings/index.js');
  }
  await copyFile(indexSrc, path.join(OUT_DIR, 'wasi-js-bindings/index.js'));
  return (
    1 +
    (await copyTree(
      path.join(LIBAPPS, 'wasi-js-bindings/js'),
      path.join(OUT_DIR, 'wasi-js-bindings/js'),
      { filter: (p) => p.endsWith('.js') },
    ))
  );
}

async function copyPluginAssets() {
  let count = 0;
  const hashSrc = path.join(PLUGIN_SRC, '.hash');
  if (exists(hashSrc)) {
    await copyFile(hashSrc, path.join(OUT_DIR, 'plugin/.hash'));
    count += 1;
  }
  for (const subdir of ['wasm', 'wasm-openssh-8.6']) {
    const src = path.join(PLUGIN_SRC, subdir);
    const dest = path.join(OUT_DIR, 'plugin', subdir);
    count += await copyTree(src, dest, {
      filter: (p) => p.endsWith('.wasm'),
    });
  }
  return count;
}

/** Copy libdot/hterm/nassh JS for CommandInstance bridge (preserves libapps import paths). */
async function copyNasshBridgeModules() {
  let count = 0;

  const jsFilter = (p) => p.endsWith('.js');

  count += await copyTree(
    path.join(LIBAPPS, 'libdot/js'),
    path.join(OUT_DIR, 'libdot/js'),
    { filter: jsFilter },
  );
  const libdotIndex = path.join(LIBAPPS, 'libdot/index.js');
  if (exists(libdotIndex)) {
    await copyFile(libdotIndex, path.join(OUT_DIR, 'libdot/index.js'));
    count += 1;
  }
  count += await copyTree(
    path.join(LIBAPPS, 'libdot/dist/js'),
    path.join(OUT_DIR, 'libdot/dist/js'),
    { filter: jsFilter },
  );

  count += await copyTree(
    path.join(LIBAPPS, 'hterm/js'),
    path.join(OUT_DIR, 'hterm/js'),
    { filter: jsFilter },
  );
  const htermIndex = path.join(LIBAPPS, 'hterm/index.js');
  if (exists(htermIndex)) {
    await copyFile(htermIndex, path.join(OUT_DIR, 'hterm/index.js'));
    count += 1;
  }
  count += await copyTree(
    path.join(LIBAPPS, 'hterm/dist/js'),
    path.join(OUT_DIR, 'hterm/dist/js'),
    { filter: jsFilter },
  );
  const wcwidth = path.join(LIBAPPS, 'hterm/third_party/wcwidth/wc.js');
  if (exists(wcwidth)) {
    await copyFile(wcwidth, path.join(OUT_DIR, 'hterm/third_party/wcwidth/wc.js'));
    count += 1;
  }

  count += await copyTree(
    path.join(LIBAPPS, 'nassh/js'),
    path.join(OUT_DIR, 'nassh/js'),
    { filter: jsFilter },
  );
  count += await copyTree(
    path.join(LIBAPPS, 'nassh/third_party/google-smart-card'),
    path.join(OUT_DIR, 'nassh/third_party/google-smart-card'),
    { filter: jsFilter },
  );

  // nassh/js imports ../wassh/js/* — mirror upstream nassh/wassh → ../../wassh/js symlink.
  const nasshWasshLink = path.join(OUT_DIR, 'nassh/wassh/js');
  await ensureDir(path.dirname(nasshWasshLink));
  if (exists(nasshWasshLink)) {
    await fsp.rm(nasshWasshLink, { recursive: true, force: true });
  }
  await fsp.symlink('../../wassh/js', nasshWasshLink);
  manifest.push({
    dest: 'nassh/wassh/js',
    bytes: 0,
    source: 'symlink → ../../wassh/js',
  });

  // Browser module resolution is URL-based, not symlink-target based.  When a
  // module is requested as /upstream/nassh/wassh/js/process.js, its
  // ../../wasi-js-bindings import resolves under /upstream/nassh/.
  const nasshWasiLink = path.join(OUT_DIR, 'nassh/wasi-js-bindings');
  if (exists(nasshWasiLink)) {
    await fsp.rm(nasshWasiLink, { recursive: true, force: true });
  }
  await fsp.symlink('../wasi-js-bindings', nasshWasiLink);
  manifest.push({
    dest: 'nassh/wasi-js-bindings',
    bytes: 0,
    source: 'symlink → ../wasi-js-bindings',
  });

  return count;
}

async function copyNasshLocales() {
  const src = path.join(LIBAPPS, 'nassh/_locales/en/messages.json');
  if (!exists(src)) {
    console.warn('nassh en locale missing — CONNECTING may show raw i18n keys');
    return 0;
  }
  const dest = path.join(OUT_DIR, 'nassh/_locales/en/messages.json');
  await copyFile(src, dest);
  return 1;
}

async function patchWasshDirectSockets() {
  const socketsPath = path.join(OUT_DIR, 'wassh/js/sockets.js');
  let source = await fsp.readFile(socketsPath, 'utf8');

  const connectBefore = `    await this.setTcpSocket_(new TCPSocket(address, port, options));
    this.pollData_();

    return WASI.errno.ESUCCESS;`;
  const connectAfter = `    await this.setTcpSocket_(new TCPSocket(address, port, options));
    if (this.directSocketsReader_ === null) {
      return WASI.errno.ENETUNREACH;
    }
    this.pollData_();

    return WASI.errno.ESUCCESS;`;
  if (!source.includes(connectBefore)) {
    throw new Error('wassh/js/sockets.js WebTcpSocket.connect pattern not found');
  }
  source = source.replace(connectBefore, connectAfter);

  const pollBefore = `  async pollData_() {
    while (true) {
      const {value, done} = await this.directSocketsReader_.read();`;
  const pollAfter = `  async pollData_() {
    const reader = this.directSocketsReader_;
    if (!reader) {
      return;
    }
    while (true) {
      const {value, done} = await reader.read();`;
  if (!source.includes(pollBefore)) {
    throw new Error('wassh/js/sockets.js WebTcpSocket.pollData_ pattern not found');
  }
  source = source.replaceAll(pollBefore, pollAfter);

  await fsp.writeFile(socketsPath, source, 'utf8');
}

async function patchWasshTtyPixelSize() {
  const handlerPath = path.join(OUT_DIR, 'wassh/js/syscall_handler.js');
  const source = await fsp.readFile(handlerPath, 'utf8');
  await fsp.writeFile(handlerPath, patchWasshTerminalPixelSize(source), 'utf8');
}

async function patchNasshRuntimeUrls() {
  const subprocPath = path.join(OUT_DIR, 'nassh/js/nassh_subproc_wasm.js');
  let source = await fsp.readFile(subprocPath, 'utf8');
  const before = "sanitizeScriptUrl(`../wassh/js/worker.js?trace=${this.trace_}`)";
  const after = "sanitizeScriptUrl(`/upstream/wassh/js/worker.js?trace=${this.trace_}`)";
  if (!source.includes(before)) {
    throw new Error('nassh_subproc_wasm.js worker URL pattern not found');
  }
  source = source.replace(before, after);
  await fsp.writeFile(subprocPath, source, 'utf8');
}

function printManifest() {
  manifest.sort((a, b) => a.dest.localeCompare(b.dest));
  const total = manifest.reduce((sum, row) => sum + row.bytes, 0);
  console.log('\nCopied upstream asset manifest:');
  console.log('─'.repeat(72));
  for (const row of manifest) {
    const kb = (row.bytes / 1024).toFixed(1).padStart(8);
    console.log(`${kb} KiB  ${row.dest}`);
  }
  console.log('─'.repeat(72));
  console.log(
    `${manifest.length} file(s), ${(total / 1024).toFixed(1)} KiB total → ${path.relative(REPO_ROOT, OUT_DIR)}/`,
  );
}

async function main() {
  console.log('Gosh upstream asset fetch (Phase 1)\n');

  if (exists(OUT_DIR)) {
    await fsp.rm(OUT_DIR, { recursive: true, force: true });
  }

  const pluginResult = tryFetchPlugin();
  if (!pluginResult.ok) {
    console.warn(`\n⚠ Plugin fetch skipped: ${pluginResult.reason}`);
    await writeStub(pluginResult.reason);
    printManifest();
    console.log('\nStub layout written. Re-run after submodule/plugin are available.');
    process.exitCode = 1;
    return;
  }

  if (!exists(LIBAPPS)) {
    const reason = 'upstream/libapps submodule missing';
    console.warn(`\n⚠ ${reason}`);
    await writeStub(reason);
    printManifest();
    process.exitCode = 1;
    return;
  }

  await ensureDir(OUT_DIR);

  const wasshCount = await copyWasshJs();
  const wasiCount = await copyWasiBindings();
  const pluginCount = await copyPluginAssets();
  const nasshCount = await copyNasshBridgeModules();
  await copyNasshLocales();
  await patchWasshDirectSockets();
  await patchWasshTtyPixelSize();
  await patchNasshRuntimeUrls();

  if (wasshCount === 0) {
    throw new Error('no wassh/js/*.js files copied');
  }
  if (wasiCount === 0) {
    throw new Error('no wasi-js-bindings JS files copied');
  }
  if (pluginCount === 0) {
    throw new Error('no plugin .wasm files copied — run upstream/libapps/nassh/bin/plugin');
  }
  const defaultWasmOut = path.join(OUT_DIR, 'plugin/wasm/ssh.wasm');
  const moshWasmOut = path.join(OUT_DIR, 'plugin/wasm/mosh-client.wasm');
  if (!exists(defaultWasmOut)) {
    throw new Error(
      `missing ${path.relative(REPO_ROOT, defaultWasmOut)} — default client is plugin/wasm/, not wasm-openssh-* only`,
    );
  }
  if (!exists(moshWasmOut)) {
    throw new Error(
      `missing ${path.relative(REPO_ROOT, moshWasmOut)} — Mosh reset support requires mosh-client.wasm`,
    );
  }
  if (nasshCount === 0) {
    throw new Error('no nassh bridge JS files copied');
  }

  const manifestPath = path.join(OUT_DIR, 'manifest.json');
  const payload = {
    generatedAt: new Date().toISOString(),
    upstreamBase: '/upstream',
    workerUrl: '/upstream/wassh/js/worker.js',
    pluginBase: '/upstream/plugin',
    defaultSshWasm: '/upstream/plugin/wasm/ssh.wasm',
    defaultMoshWasm: '/upstream/plugin/wasm/mosh-client.wasm',
    nasshCommandUrl: '/upstream/nassh/js/nassh_command_instance.js',
    files: manifest.map(({ dest, bytes, source }) => ({ dest, bytes, source })),
  };
  await fsp.writeFile(manifestPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  const { size } = await fsp.stat(manifestPath);
  manifest.push({
    dest: 'manifest.json',
    bytes: size,
    source: '(generated)',
  });

  printManifest();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
