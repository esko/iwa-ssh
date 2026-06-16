/**
 * Shared SSH helpers for smoke tests (key auth + optional TTY).
 */

import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

export const SSH_HOST = process.env.SSH_HOST ?? '127.0.0.1';
export const SSH_PORT = Number(process.env.SSH_PORT ?? 2222);
export const SSH_USER = process.env.SSH_USER ?? 'test';
export const SSH_KEY = process.env.SSH_KEY ?? join(repoRoot, 'tests/fixtures/keys/smoke');

export function tcpProbe(host, port, timeoutMs = 5000) {
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

function sshBaseArgs() {
  if (!existsSync(SSH_KEY)) {
    throw new Error(
      `SSH key not found: ${SSH_KEY}\n` +
        '  Run: bash tests/fixtures/generate-keys.sh\n' +
        '  Or set SSH_KEY to your fixture private key',
    );
  }

  return [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-i', SSH_KEY,
    '-p', String(SSH_PORT),
  ];
}

/**
 * @param {string} remoteCommand
 * @param {{ tty?: boolean }} [options]
 */
export function sshRun(remoteCommand, options = {}) {
  const args = [...sshBaseArgs()];
  if (options.tty) {
    args.push('-tt');
  }
  args.push(`${SSH_USER}@${SSH_HOST}`, remoteCommand);

  return spawnSync('ssh', args, {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 45000,
  });
}

export function sshOutput(result) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
}
