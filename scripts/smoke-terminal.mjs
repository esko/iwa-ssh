#!/usr/bin/env node
/**
 * Smoke test orchestrator (issue #16).
 *
 * 1. SSH fixture reachability + key auth + PTY vim/tmux/fish checks
 * 2. Echo-stub CDP checks when dev server is running
 * 3. Prints manual IWA checklist for full terminal UI validation
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInteractiveSmokeTests } from './smoke-ssh-interactive.mjs';
import { SSH_HOST, SSH_PORT, SSH_USER, SSH_KEY, sshOutput, sshRun, tcpProbe } from './smoke-ssh-lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

async function main() {
  console.log('Gosh smoke runner\n');
  let exitCode = 0;

  console.log('── SSH fixture ──');
  const tcpOk = await tcpProbe(SSH_HOST, SSH_PORT);
  if (tcpOk) {
    console.log(`  ✓ TCP ${SSH_HOST}:${SSH_PORT} reachable`);
    try {
      const authProbe = sshRun('echo smoke-ok');
      if (authProbe.status === 0 && authProbe.stdout?.includes('smoke-ok')) {
        console.log(`  ✓ SSH key auth (${SSH_USER}@${SSH_HOST}:${SSH_PORT})`);
      } else {
        console.log(`  ⚠ TCP open but SSH key auth failed — check fixture key and compose:`);
        console.log(`    key: ${SSH_KEY}`);
        console.log('    cd tests/fixtures && bash generate-keys.sh && docker compose up -d --build');
        if (authProbe.status !== 0) {
          console.log(`    ${sshOutput(authProbe)}`);
        }
      }
    } catch (error) {
      console.log(`  ⚠ ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    console.log(`  ⚠ SSH fixture not reachable at ${SSH_HOST}:${SSH_PORT}`);
    console.log('    Start: cd tests/fixtures && docker compose up -d --build');
    console.log('    Or set SSH_HOST / SSH_PORT for your test server');
  }

  console.log('\n── SSH interactive (vim / tmux / fish, PTY) ──');
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

  console.log('\n── Manual IWA SSH checklist (full UI) ──');
  console.log('PTY checks above verify remote packages over ssh -tt; IWA terminal behavior:');
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
