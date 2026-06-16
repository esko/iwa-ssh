#!/usr/bin/env node
/**
 * SSH smoke tests for vim, tmux, and fish over a PTY (issue #16).
 * Uses key-based auth against tests/fixtures/docker-compose.yml.
 */

import { fileURLToPath } from 'node:url';
import {
  SSH_HOST,
  SSH_PORT,
  SSH_USER,
  SSH_KEY,
  sshOutput,
  sshRun,
  tcpProbe,
} from './smoke-ssh-lib.mjs';

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
 */
export async function runInteractiveSmokeTests(options = {}) {
  const log = options.log ?? console.log;
  const checks = [];

  const tcpOk = await tcpProbe(SSH_HOST, SSH_PORT);
  if (!tcpOk) {
    return { skipped: true, reachable: false, checks };
  }

  let authProbe;
  try {
    authProbe = sshRun('echo smoke-ok');
  } catch (error) {
    checks.push(fail('SSH key auth', error instanceof Error ? error.message : String(error), log));
    return { skipped: false, reachable: true, checks };
  }

  if (authProbe.status !== 0 || !authProbe.stdout?.includes('smoke-ok')) {
    checks.push(
      fail(
        'SSH key auth',
        `auth failed — check fixture key (${SSH_KEY}) and PUBLIC_KEY_FILE in docker compose`,
        log,
      ),
    );
    return { skipped: false, reachable: true, checks };
  }
  checks.push(pass('SSH key auth', log));

  const vim = sshRun(
    "vim -u NONE -es -c 'set term=xterm-256color' -c 'startinsert' -c 'put!\"smoke\"' -c ':wq' && echo vim-ok",
    { tty: true },
  );
  if (vim.status === 0 && vim.stdout?.includes('vim-ok')) {
    checks.push(pass('vim (PTY) insert and quit', log));
  } else {
    checks.push(fail('vim (PTY) insert and quit', sshOutput(vim) || `exit ${vim.status}`, log));
  }

  const tmux = sshRun(
    "tmux new-session -d -s smoke 'bash -lc \"echo tmux-ok\"' && tmux capture-pane -p -t smoke -e && tmux kill-session -t smoke",
    { tty: true },
  );
  if (tmux.status === 0 && tmux.stdout?.includes('tmux-ok')) {
    checks.push(pass('tmux (PTY) session', log));
  } else {
    checks.push(fail('tmux (PTY) session', sshOutput(tmux) || `exit ${tmux.status}`, log));
  }

  const fishPath = sshRun('command -v fish');
  if (fishPath.status !== 0 || !fishPath.stdout?.trim()) {
    checks.push({
      name: 'fish (PTY) shell',
      ok: true,
      detail: 'skipped — fish not installed on remote',
    });
    log('  ⊘ fish (PTY) shell: skipped — fish not installed on remote');
  } else {
    const fish = sshRun('fish -c "echo fish-ok"', { tty: true });
    if (fish.status === 0 && fish.stdout?.includes('fish-ok')) {
      checks.push(pass('fish (PTY) shell', log));
    } else {
      checks.push(fail('fish (PTY) shell', sshOutput(fish) || `exit ${fish.status}`, log));
    }
  }

  return { skipped: false, reachable: true, checks };
}

async function main() {
  console.log('SSH interactive smoke (vim / tmux / fish, PTY)\n');

  const { skipped, reachable, checks } = await runInteractiveSmokeTests();

  if (skipped) {
    console.log(`  ⚠ SSH fixture not reachable at ${SSH_HOST}:${SSH_PORT}`);
    console.log('    Start: cd tests/fixtures && docker compose up -d --build');
    console.log('    Keys:  bash tests/fixtures/generate-keys.sh');
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
