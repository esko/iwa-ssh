#!/usr/bin/env node
/**
 * Start Vite dev server and open Chrome on /debug for inspection.
 *
 * Chrome opens with remote debugging on port 9222 so DevTools / CDP clients
 * (including agent-browser) can attach.
 */

import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.GOSH_DEV_PORT || 5173);
const DEV_URL = `http://127.0.0.1:${PORT}/debug`;
const IWA_PROXY_URL = `http://127.0.0.1:${PORT}/`;
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT || 9222);

function waitForPort(port, timeoutMs = 30_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const socket = createConnection({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.end();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timed out waiting for port ${port}`));
          return;
        }
        setTimeout(tryOnce, 250);
      });
    };
    tryOnce();
  });
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
  ].filter(Boolean);

  return candidates[0];
}

const vite = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(PORT)], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: true,
});

let chrome;
let exiting = false;

const shutdown = (code = 0) => {
  if (exiting) return;
  exiting = true;
  if (chrome && !chrome.killed) chrome.kill();
  if (!vite.killed) vite.kill();
  process.exit(code);
};

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

vite.on('exit', (code) => shutdown(code ?? 0));

(async () => {
  try {
    await waitForPort(PORT);
    const chromeBin = findChrome();
    if (!chromeBin) {
      console.log(`\nDev server ready: ${DEV_URL}`);
      console.log(`IWA Dev Mode Proxy URL (ChromeOS): ${IWA_PROXY_URL}`);
      console.log('Set CHROME_PATH to open Chrome automatically.');
      return;
    }

    const userDataDir = join(ROOT, '.chrome-dev-profile');
    chrome = spawn(
      chromeBin,
      [
        `--remote-debugging-port=${DEBUG_PORT}`,
        `--user-data-dir=${userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        DEV_URL,
      ],
      { stdio: 'ignore', detached: false },
    );

    chrome.on('error', (err) => {
      console.error('Failed to launch Chrome:', err.message);
    });

    console.log(`\n  Dev inspector:  ${DEV_URL}`);
    console.log(`  IWA proxy URL:  ${IWA_PROXY_URL}  (chrome://web-app-internals → Dev Mode Proxy)`);
    console.log(`  CDP port:       ${DEBUG_PORT}`);
    console.log(`  Profile dir:    ${userDataDir}`);
    console.log('\n  Press Ctrl+C to stop Vite and Chrome.\n');
  } catch (err) {
    console.error(err);
    shutdown(1);
  }
})();
