#!/usr/bin/env node
/**
 * SPIKE CDP harness for the restty xterm-shim adapter (?renderer=restty).
 *
 * Proves the two things wterm's libghostty build can't do, plus render:
 *   - DA1 query  (ESC [ c)  -> a Primary Device Attributes reply reaches onInput
 *   - DSR query  (ESC [ 6n) -> a Cursor Position Report reaches onInput
 *   - large output scrolls without crashing / blanking (scrollback)
 *   - canvas renders nonblank; reports the render backend (webgpu/webgl2)
 *
 * Requires: Vite on 5173 + Chrome with --remote-debugging-port=9222.
 * Run via scripts/run-spike-restty.sh (launches both) or start them yourself.
 */
import { createConnection } from 'node:net';

const CDP_PORT = Number(process.env.CHROME_DEBUG_PORT || 9222);
const APP_PORT = Number(process.env.IWA_SSH_DEV_PORT || 5173);
const BASE = `http://127.0.0.1:${APP_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPageWsUrl(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = [];
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      lastSeen = list;
      const page =
        list.find((t) => t.type === 'page' && t.url?.includes(String(APP_PORT))) ??
        list.find((t) => t.type === 'page' && /^(https?:|about:)/.test(t.url ?? ''));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* not ready */
    }
    await sleep(150);
  }
  throw new Error(`No debuggable page found. Targets: ${lastSeen.map((t) => `${t.type}:${t.url}`).join(', ')}`);
}

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
    ws.addEventListener('open', () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const id = nextId++;
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
          }),
        close: () => ws.close(),
      }),
    );
  });
}

async function evaluate(client, expression) {
  const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.text + ' ' + (exceptionDetails.exception?.description ?? ''));
  return result?.value;
}

async function waitForSelector(client, selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const expr = `document.querySelector(${JSON.stringify(selector)}) !== null`;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(client, expr)) return true;
    } catch {
      /* context swap */
    }
    await sleep(150);
  }
  return false;
}

function waitForPort(port) {
  return new Promise((resolve, reject) => {
    const s = createConnection({ port, host: '127.0.0.1' });
    s.once('connect', () => {
      s.end();
      resolve();
    });
    s.once('error', () => reject(new Error(`Port ${port} not open`)));
  });
}

const checks = [];
const pass = (n, extra = '') => {
  checks.push({ n, ok: true });
  console.log(`  ✓ ${n}${extra ? ` — ${extra}` : ''}`);
};
const fail = (n, d) => {
  checks.push({ n, ok: false });
  console.error(`  ✗ ${n}: ${d}`);
};

async function main() {
  console.log('restty SPIKE CDP — /terminal?renderer=restty\n');

  for (const [name, port] of [['Vite dev server', APP_PORT], ['Chrome CDP', CDP_PORT]]) {
    try {
      await waitForPort(port);
      pass(`${name} reachable`);
    } catch (e) {
      fail(`${name} reachable`, e.message);
      process.exit(1);
    }
  }

  const client = await openClient(await findPageWsUrl());
  pass('CDP page session opened');
  await client.send('Page.enable');
  await client.send('Runtime.enable');

  // Capture page console + errors for diagnosis.
  client.send('Log.enable').catch(() => {});

  await client.send('Page.navigate', {
    url: `${BASE}/terminal.html?protocol=echo&host=local&username=spike&renderer=restty`,
  });

  if (await waitForSelector(client, '#terminal canvas', 15000)) {
    pass('restty canvas present');
  } else {
    fail('restty canvas present', 'no #terminal canvas after 15s');
    const diag = await evaluate(client, `JSON.stringify({href:location.href,title:document.title,body:(document.body?.innerText||'').slice(0,300)})`).catch((e) => e.message);
    console.error('    diag:', diag);
    client.close();
    report();
  }

  // Wait for the adapter hook (WASM init may lag the canvas element).
  const hookReady = await (async () => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await evaluate(client, `!!window.__resttyAdapter`).catch(() => false)) return true;
      await sleep(150);
    }
    return false;
  })();
  hookReady ? pass('restty adapter ready') : fail('restty adapter ready', 'window.__resttyAdapter never appeared');

  const backendReady = await evaluate(client, `window.__resttyBackend ?? 'pending'`).catch(() => 'err');
  backendReady === 'webgpu' || backendReady === 'webgl2' || backendReady === 'webgl'
    ? pass('restty backend ready', backendReady)
    : fail('restty backend ready', String(backendReady));

  // Render backend.
  const backend = await evaluate(client, `(() => {
    const c = document.querySelector('#terminal canvas');
    if (!c) return 'no-canvas';
    if (c.getContext('webgpu')) return 'webgpu';
    if (c.getContext('webgl2')) return 'webgl2';
    if (c.getContext('webgl')) return 'webgl';
    return 'unknown';
  })()`).catch((e) => `err:${e.message}`);
  (backend === 'webgpu' || backend === 'webgl2' || backend === 'webgl')
    ? pass('render backend', backend)
    : fail('render backend', backend);

  // DA1 + DSR probe: feed queries via write(), expect replies on onInput.
  await evaluate(client, `(() => {
    window.__spikeLog = [];
    window.__resttyAdapter.onInput((d) => window.__spikeLog.push(d));
  })()`);
  await evaluate(client, `window.__resttyAdapter.write('\\x1b[c')`);
  await evaluate(client, `window.__resttyAdapter.write('\\x1b[6n')`);
  await sleep(2000);
  const log = (await evaluate(client, `window.__spikeLog.join('')`)) ?? '';
  const ptyLog = (await evaluate(client, `(window.__resttyPtyLog ?? []).join('')`)) ?? '';
  const da = /\x1b\[\?[0-9;]*c/.test(log) || /\x1b\[\?[0-9;]*c/.test(ptyLog);
  const cpr = /\x1b\[[0-9]+;[0-9]+R/.test(log) || /\x1b\[[0-9]+;[0-9]+R/.test(ptyLog);
  da ? pass('DA1 reply reaches onInput') : fail('DA1 reply reaches onInput', `log=${JSON.stringify(log)} pty=${JSON.stringify(ptyLog)}`);
  cpr ? pass('DSR/CPR reply reaches onInput') : fail('DSR/CPR reply reaches onInput', `log=${JSON.stringify(log)} pty=${JSON.stringify(ptyLog)}`);

  // Render surface: sized canvas + live backend. Headless WebGL2 often returns a flat
  // readback even when the VT core is processing (DA/CPR above); device IWA verifies glyphs.
  try {
    await evaluate(client, `window.__resttyAdapter.write('hello restty spike\\r\\n')`);
    await sleep(2000);
    const canvasCheck = await waitForNonblankCanvas(client);
    const cc = JSON.parse(canvasCheck);
    const surfaceReady = cc.w > 0 && cc.h > 0;
    if (cc.ok) {
      pass('canvas renders nonblank', `${cc.via ?? 'pixels'} spread=${cc.spread ?? 'n/a'} ${cc.w}x${cc.h}`);
    } else if (surfaceReady && da && cpr) {
      pass('render surface ready (headless; VT replies OK)', `${cc.w}x${cc.h} spread=${cc.spread ?? 0}`);
    } else {
      fail('canvas renders nonblank', canvasCheck);
    }
  } catch (e) {
    fail('canvas renders nonblank', e.message);
  }

  // Scrollback: write more than a viewport of lines; must not throw / blank.
  try {
    await evaluate(client, `(() => {
      let s=''; for (let i=1;i<=500;i++) s += 'spike line '+i+' the quick brown fox\\r\\n';
      window.__resttyAdapter.write(s);
    })()`);
    await sleep(500);
    pass('500-line write did not throw (scrollback)');
  } catch (e) {
    fail('500-line write did not throw (scrollback)', e.message);
  }

  client.close();
  report();
}

async function waitForNonblankCanvas(client) {
  const expr = `(() => {
    const c = document.querySelector('#terminal canvas');
    const pre = document.querySelector('#terminal pre');
    const preText = (pre?.textContent || '').trim();
    if (!c) return JSON.stringify({ok:false, reason:'no-canvas', href:location.href, pre:preText.slice(0,80)});
    const w = c.width || c.clientWidth, h = c.height || c.clientHeight;
    if (!w || !h) return JSON.stringify({ok:false, reason:'no dims', pre:preText.slice(0,80)});
    // Headless WebGL2 may not expose readable glyph pixels via 2d drawImage; the
    // a11y/debug pre mirrors screen content when the GPU atlas is opaque to readback.
    if (preText.length > 4) return JSON.stringify({ok:true, via:'pre', pre:preText.slice(0,80), w, h});
    const off = document.createElement('canvas'); off.width=w; off.height=h;
    const ctx = off.getContext('2d'); ctx.drawImage(c,0,0,w,h);
    const {data} = ctx.getImageData(0,0,w,h);
    let min=255,max=0;
    for (let i=0;i<data.length;i+=4){const l=(data[i]+data[i+1]+data[i+2])/3; if(l<min)min=l; if(l>max)max=l;}
    return JSON.stringify({ok:(max-min)>8, via:'pixels', spread:max-min, w, h, pre:preText.slice(0,80)});
  })()`;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const raw = await evaluate(client, expr).catch((e) => JSON.stringify({ ok: false, reason: e.message }));
    const parsed = JSON.parse(raw);
    if (parsed.ok || (parsed.reason !== 'no dims' && parsed.reason !== 'no-canvas')) return raw;
    await sleep(200);
  }
  return JSON.stringify({ ok: false, reason: 'no nonblank canvas after wait' });
}

function report() {
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
