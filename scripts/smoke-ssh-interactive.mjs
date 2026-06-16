#!/usr/bin/env node
/**
 * Non-interactive SSH smoke tests for vim, tmux, and fish (issue #16).
 * Requires SSH fixture from tests/fixtures/docker-compose.yml.
 */

import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';

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

function sshRun(remoteCommand) {
  return spawnSync(
    'ssh',
    [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'BatchMode=no',
      '-p', String(SSH_PORT),
      `${SSH_USER}@${SSH_HOST}`,
      remoteCommand,
    ],
    {
      input: `${SSH_PASS}\n`,
      encoding: 'utf8',
      timeout: 30000,
    },
  );
}

function pass(name, log) {
  log(`  ✓ ${name}`);
  return { name, ok: true };
}

function fail(name, detail, log) {
  log(`  ✗ ${name}: ${detail}`);
  return { name, ok: false, detail };
}

/**
 * @param {{ log?: (msg: string) => void }} [options]
 * @returns {Promise<{ skipped: boolean, reachable: boolean, checks: Array<{ name: string, ok: boolean, detail?: string }> }>}
 */
export async function runInteractiveSmokeTests(options = {}) {
  const log = options.log ?? console.log;
  const checks = [];

  const tcpOk = await tcpProbe(SSH_HOST, SSH_PORT);
  if (!tcpOk) {
    return { skipped: true, reachable: false, checks };
  }

  const authProbe = sshRun('echo smoke-ok');
  if (authProbe.status !== 0 || !authProbe.stdout?.includes('smoke-ok')) {
    checks.push(fail('SSH password auth', 'auth failed — check SSH_USER/SSH_PASS', log));
    return { skipped: false, reachable: true, checks };
  }
  checks.push(pass('SSH password auth', log));

  const vim = sshRun("vim -u NONE -es -c 'q'");
  if (vim.status === 0) {
    checks.push(pass('vim enter/exit', log));
  } else {
    const detail = (vim.stderr || vim.stdout || `exit ${vim.status}`).trim();
    checks.push(fail('vim enter/exit', detail, log));
  }

  const tmux = sshRun(
    "tmux new-session -d -s smoke 'echo tmux-ok' && tmux capture-pane -p -t smoke",
  );
  if (tmux.status === 0 && tmux.stdout?.includes('tmux-ok')) {
    checks.push(pass('tmux new-session', log));
    sshRun('tmux kill-session -t smoke 2>/dev/null || true');
  } else {
    const detail = (tmux.stderr || tmux.stdout || `exit ${tmux.status}`).trim();
    checks.push(fail('tmux new-session', detail, log));
  }

  const fishPath = sshRun('command -v fish');
  if (fishPath.status !== 0 || !fishPath.stdout?.trim()) {
    checks.push({
      name: 'fish shell',
      ok: true,
      detail: 'skipped — fish not installed on remote',
    });
    log('  ⊘ fish shell: skipped — fish not installed on remote');
  } else {
    const fish = sshRun("fish -c 'echo fish-ok'");
    if (fish.status === 0 && fish.stdout?.includes('fish-ok')) {
      checks.push(pass('fish shell', log));
    } else {
      const detail = (fish.stderr || fish.stdout || `exit ${fish.status}`).trim();
      checks.push(fail('fish shell', detail, log));
    }
  }

  return { skipped: false, reachable: true, checks };
}

async function main() {
  console.log('SSH interactive smoke (vim / tmux / fish)\n');

  const { skipped, reachable, checks } = await runInteractiveSmokeTests();

  if (skipped) {
    console.log(`  ⚠ SSH fixture not reachable at ${SSH_HOST}:${SSH_PORT}`);
    console.log('    Start: cd tests/fixtures && docker compose up -d');
    console.log('    Or set SSH_HOST / SSH_PORT for your test server');
    console.log('\nSkipped (fixture offline).');
    process.exit(0);
  }

  if (!reachable) {
    process.exit(1);
  }

  const failed = checks.filter((c) => !c.ok).length;
  const passed = checks.length - failed;
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(failed > 0 ? 1 : 0);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
