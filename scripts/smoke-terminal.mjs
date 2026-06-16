#!/usr/bin/env node
/**
 * Smoke test orchestrator (issue #16).
 *
 * 1. Optional SSH fixture reachability (SSH_HOST / SSH_PORT / SSH_USER / SSH_PASS)
 * 2. Echo-stub CDP checks when dev server is running
 * 3. Prints manual vim/tmux/fish checklist for IWA live SSH
 */

import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInteractiveSmokeTests } from './smoke-ssh-interactive.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const SSH_HOST = process.env.SSH_HOST ?? '127.0.0.1';
const SSH_PORT = Number(process.env.SSH_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? 'test';
const SSH_PASS = process.env.SSH_PASS ?? 'test';

function tcpProbe(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function sshPasswordProbe() {
  const result = spawnSync(
    'ssh',
    [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'BatchMode=no',
      '-p', String(SSH_PORT),
      `${SSH_USER}@${SSH_HOST}`,
      'echo', 'smoke-ok',
    ],
    {
      input: `${SSH_PASS}\n`,
      encoding: 'utf8',
      timeout: 15000,
    },
  );
  return result.status === 0 && result.stdout?.includes('smoke-ok');
}

async function main() {
  console.log('iwa-ssh smoke runner\n');
  let exitCode = 0;

  console.log('── SSH fixture ──');
  const tcpOk = await tcpProbe(SSH_HOST, SSH_PORT);
  if (tcpOk) {
    console.log(`  ✓ TCP ${SSH_HOST}:${SSH_PORT} reachable`);
    const sshOk = await sshPasswordProbe();
    if (sshOk) {
      console.log(`  ✓ SSH password auth (${SSH_USER}@${SSH_HOST}:${SSH_PORT})`);
    } else {
      console.log(`  ⚠ TCP open but SSH auth failed — check SSH_USER/SSH_PASS or start fixture:`);
      console.log('    cd tests/fixtures && docker compose up -d');
    }
  } else {
    console.log(`  ⚠ SSH fixture not reachable at ${SSH_HOST}:${SSH_PORT}`);
    console.log('    Start: cd tests/fixtures && docker compose up -d');
    console.log('    Or set SSH_HOST / SSH_PORT for your test server');
  }

  console.log('\n── SSH interactive (vim / tmux / fish) ──');
  const interactive = await runInteractiveSmokeTests();
  if (interactive.skipped) {
    console.log(`  ⚠ Skipped — fixture not reachable at ${SSH_HOST}:${SSH_PORT}`);
  } else {
    const failed = interactive.checks.filter((c) => !c.ok).length;
    if (failed > 0) exitCode = 1;
  }

  console.log('\n── Echo-stub CDP (optional) ──');
  const echo = spawnSync('node', [join(__dirname, 'smoke-echo.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (echo.status === 0) {
    console.log(echo.stdout);
  } else {
    console.log('  ⚠ Skipped or failed — start dev:chrome for automated UI checks');
    if (echo.stderr) console.log(echo.stderr.trim());
  }

  console.log('\n── Manual IWA SSH checklist (vim / tmux / fish) ──');
  console.log('Install via Dev Mode Proxy or signed .swbn, then follow:');
  console.log('  tests/e2e/smoke-terminal.spec.md\n');

  const specPath = join(ROOT, 'tests/e2e/smoke-terminal.spec.md');
  const lines = readFileSync(specPath, 'utf8').split('\n');
  const preflight = lines.filter((l) => l.startsWith('- [ ]')).slice(0, 4);
  preflight.forEach((l) => console.log(`  ${l.replace('- [ ]', '□')}`));

  console.log(exitCode === 0 ? '\nDone.' : '\nDone (failures above).');
  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
