#!/usr/bin/env node
/**
 * CDP smoke test for echo-stub session (no SSH required).
 * Requires: npm run dev:chrome (or Vite on 5173 + Chrome with --remote-debugging-port=9222)
 */

import { createConnection } from 'node:net';

const CDP_PORT = Number(process.env.CHROME_DEBUG_PORT || 9222);
const APP_PORT = Number(process.env.IWA_SSH_DEV_PORT || 5173);
const BASE = `http://127.0.0.1:${APP_PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  return res.json();
}

/**
 * Find the page target's debugger URL, retrying because /json/list is racy
 * while a tab is navigating/reloading. Prefer the app page; fall back to any
 * real page target.
 */
async function findPageWsUrl(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = [];
  while (Date.now() < deadline) {
    try {
      const list = await listTargets();
      lastSeen = list;
      const page =
        list.find((t) => t.type === 'page' && t.url?.includes(String(APP_PORT))) ??
        list.find((t) => t.type === 'page' && /^(https?:|about:)/.test(t.url ?? ''));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // CDP endpoint not ready yet — keep polling.
    }
    await sleep(150);
  }
  const summary = lastSeen.map((t) => `${t.type}:${t.url}`).join(', ') || '(empty target list)';
  throw new Error(`No debuggable page found — run npm run dev:chrome first. Targets: ${summary}`);
}

/** Open one persistent CDP session and reuse it for every command. */
function openClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      }
    });
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket error')));
    ws.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = nextId++;
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close: () => ws.close(),
      });
    });
  });
}

async function evaluate(client, expression) {
  const { result } = await client.send('Runtime.evaluate', { expression, returnByValue: true });
  return result?.value;
}

async function waitForSelector(client, selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const expression = `document.querySelector(${JSON.stringify(selector)}) !== null`;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(client, expression)) return true;
    } catch {
      // Execution context swapping during navigation — retry.
    }
    await sleep(150);
  }
  return false;
}

async function pageDiagnostics(client) {
  const expression = `JSON.stringify({
    href: location.href,
    readyState: document.readyState,
    title: document.title,
    appExists: !!document.querySelector('#app'),
    appChildCount: document.querySelector('#app')?.childElementCount ?? -1,
    formIds: [...document.querySelectorAll('form')].map((f) => f.id),
    bodyTextStart: (document.body?.innerText ?? '').slice(0, 200),
  })`;
  try {
    return JSON.parse((await evaluate(client, expression)) ?? '{}');
  } catch (error) {
    return { diagnosticsError: error.message };
  }
}

function waitForPort(port) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.end();
      resolve();
    });
    socket.once('error', () => reject(new Error(`Port ${port} not open`)));
  });
}

const checks = [];

function pass(name) {
  checks.push({ name, ok: true });
  console.log(`  ✓ ${name}`);
}

function fail(name, detail) {
  checks.push({ name, ok: false, detail });
  console.error(`  ✗ ${name}: ${detail}`);
}

async function main() {
  console.log('Echo-stub CDP smoke\n');

  try {
    await waitForPort(APP_PORT);
    pass('Vite dev server reachable');
  } catch (error) {
    fail('Vite dev server reachable', error.message);
    process.exit(1);
  }

  try {
    await waitForPort(CDP_PORT);
    pass('Chrome CDP port open');
  } catch (error) {
    fail('Chrome CDP port open', error.message);
    console.log('\nRun: npm run dev:chrome');
    process.exit(1);
  }

  let client;
  try {
    client = await openClient(await findPageWsUrl());
    pass('CDP page session opened');
  } catch (error) {
    fail('CDP page session opened', error.message);
    console.log('\nRun: npm run dev:chrome');
    process.exit(1);
  }

  try {
    await client.send('Page.enable');
    await client.send('Page.navigate', { url: `${BASE}/connect` });
    pass('Navigate to /connect');
  } catch (error) {
    fail('Navigate to /connect', error.message);
  }

  // The SPA router renders the connect form asynchronously after navigation
  // commits, so poll for #host rather than checking once immediately.
  const found = await waitForSelector(client, '#host', 8000);
  if (found) {
    pass('Connect form present');
  } else {
    fail('Connect form present', 'missing #host after 8s — connect route did not render');
    const diag = await pageDiagnostics(client);
    console.error('    diagnostics:', JSON.stringify(diag, null, 2).replace(/\n/g, '\n    '));
  }

  client.close();

  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
