# restty spike handoff (`spike/restty-iwa`)

**Status:** Phase 0 spike works; **trackpad scrollback scroll is FIXED** (was broken on device — ChromeOS IWA via dev proxy).

## Scroll fix (root cause + resolution)

**Primary root cause: the terminal canvas was sized square and overflowed the
viewport, so the live area / new output fell below the fold and trackpad scroll
over it didn't behave.**

restty injects a stylesheet at mount (`data-restty-pane-styles`) containing
`.restty-pane-root { height: 100% }`. `#terminal` carries both `.term-full`
(our `height: 100vh`) and `.restty-pane-root`; equal specificity means the
later-injected restty rule wins, so the fixed `100vh` became `height: 100%`.
With no definite ancestor height, `height: 100%` resolves to `auto`, so
`#terminal` collapsed onto the canvas's intrinsic **square** pixel size
(e.g. 1280×1280 in an 800px-tall viewport) and overflowed below the fold. This
matches the device reports: text renders, "new output draws below visible area",
and scroll "works over the debug panel" (a separate `overflow:auto` element)
but not over the terminal.

**Fix:** pin a definite viewport height on `#terminal[data-renderer='restty']`
(id+attr specificity beats `.restty-pane-root`) in `styles.css`. Verified
headless (1280×800 device metrics + `maxTouchPoints` override): canvas now
sizes to the viewport (1280×800, not square), `onGridSize` reports a sane grid,
dispatched wheels report `defaultPrevented === true`, and the canvas visibly
changes on scroll (screenshot diff).

**Secondary hardening: bundle the terminal font (cellH guarantee).**

- On touch devices (`navigator.maxTouchPoints > 0`) restty installs **no native
  scroll host** (`scrollbar-runtime.ts` L52–69) — scrollback relies entirely on
  the canvas `onWheel` handler.
- That handler early-returns when `getGridState().cellH === 0`
  (`bind-pointer-aux-handlers.ts onWheel: !i() || !a() || !o().cellH`).
- The app passed **no `fontSources`**, so restty used its defaults: the Local
  Font Access API (gated/denied inside an IWA — no installed JetBrains Mono Nerd
  Font) and a **jsdelivr CDN** fetch (offline/blocked on device). Neither
  delivered a font buffer → `computeCellMetrics()` returned null → `cellH = 0` →
  wheel bailed → scrollback never moved. (Keys/DA/CPR still worked because they
  are VT-core, font-independent.)

**Fix:** bundle JetBrains Mono (Regular + Bold, OFL) under `app/public/fonts/`
and load them via same-origin `appOptions.fontSources` in `resttyAdapter.ts`
(allowed by the IWA CSP `connect-src 'self'`). A real font always loads →
`cellH > 0` → trackpad scrollback scrolls. Box-drawing/powerline glyphs are
drawn programmatically by restty, so a Nerd Font is not required.

**Verified headless** (Chromium CDP, `navigator.maxTouchPoints` overridden to
simulate the device's canvas-wheel-only path): before the fix `onGridSize` never
fires and dispatched wheels report `defaultPrevented === false` (handler bails);
after the fix `onGridSize` fires (`cellH > 0`), wheels report
`defaultPrevented === true`, and the rendered canvas visibly changes on scroll
(screenshot diff). Headless without a real font does NOT reproduce — its
swiftshader/no-font state mimics the bug, which is why the original device repro
was hard to chase from the harness.

---

### Original report (pre-fix)

## What landed on this branch

- Vendored `@eslzzyl/restty@0.1.37` (`vendor/restty/`, pin `cb79ed5`) — same as `/home/esko/github/restty`
- **Note:** `vendor/restty/dist/` is gitignored (`dist/` rule). After clone run `node scripts/build-restty.mjs` (or `npm install` in a tree that already has dist) before `npm run dev`.
- `ResttyTerminalAdapter` (`app/src/pwa/resttyAdapter.ts`) — default renderer on this branch; `?renderer=wterm` opts back
- Loopback `ptyTransport` so DA/DSR replies reach SSH `onInput` (xterm shim routes PTY bytes only through transport when `isConnected()`)
- Removed duplicate `term.onData` wiring (fixed doubled keypresses)
- `NasshCommandBridge` forwards `adapter.onResize` → SSH PTY resize
- Debug HUD (`dbg` button): DA probe, scroll probe, wheel log ring buffer (`window.__resttyDebugLog`)
- Spike harness: `bash scripts/run-spike-restty.sh` (11/11 pass headless: render, DA1, CPR, 500-line scrollback write)

## Confirmed working (device)

- WebGPU backend active
- DA/CPR probes pass
- Key entry and paste (single, not doubled) after connect settles
- Post-connect key delay improved via `waitForResttyReady` (DA probe, not just `getBackend()`)

## Still broken (device, trackpad)

- **Two-finger trackpad scroll** does not move scrollback viewport over the terminal canvas
- New output may draw below visible area (viewport follow / sizing — less verified after resize fixes)
- Scroll **did** work when cursor was over the **debug panel** (`.term-debug-body { overflow: auto }`) — suggests wheel is reaching a scrollable parent, not restty's canvas handler

## restty source paths (local clone: `/home/esko/github/restty`)

| Concern | File |
|---------|------|
| Wheel → scrollback | `src/runtime/create-runtime/interaction-runtime/bind-pointer-aux-handlers.ts` — `onWheel`: mouse reporting steals wheel unless `shiftKey`; bails if `!cellH` |
| Scroll math | `src/runtime/create-runtime/interaction-runtime/scrollbar-runtime.ts` — `scrollViewportByWheel`, `scrollViewportByLines` |
| Mouse hijack | `bind-pointer-events.ts` — `shouldRoutePointerToAppMouse = shiftKey ? false : inputHandler.isMouseActive()` |
| Native scrollbar disabled on touch devices | `scrollbar-runtime.ts` L52–69 — `maxTouchPoints > 0` → no native scroll host; **canvas wheel only** |
| Canvas wheel listener | `bind-pointer-events.ts` L262 — `canvas.addEventListener("wheel", onWheel)` |
| Canvas replace drops listeners | `lifecycle-theme-size-canvas.ts` — `replaceCanvas()` clears `cleanupCanvasFns` |
| DOM structure | `pane-app-manager.ts` — `.pane` > `canvas` + hidden `imeInput` + `termDebugEl` |
| Pane CSS | `panes-styles.ts` — `.pane-canvas { width/height 100% }`, ime `pointer-events: none` |

## Adapter scroll-guard hypotheses (unverified on device — no log ingest from Chromebook)

Instrumentation in `resttyAdapter.ts` (`agentLog` → ring buffer + local ingest). Session ID in code may be stale (`b42bad`); update to active debug session if using Cursor debug ingest.

| ID | Hypothesis |
|----|------------|
| H-wheel-target | Wheel `event.target` is `.pane` / `#terminal`, not `<canvas>` — restty never sees it |
| H-wheel-mouse | Remote mouse reporting active → wheel sent to SSH instead of local scrollback |
| H-wheel-cellH | `getGridState().cellH === 0` → restty `onWheel` returns early |
| H-wheel-canvas-stale | `replaceCanvas()` after backend init; adapter wheel listeners on dead canvas until resize |
| H-wheel-guard | Our `installScrollGuard` capture/`stopImmediatePropagation` may block or fail to re-dispatch synthetics |

Current guard (`installScrollGuard`): forward parent-target wheels to canvas; re-dispatch with `shiftKey` when mouse reporting active. **Do not call `updateSize` on wheel** (resets viewport).

## Repro (device)

1. `npm run dev` — install/reload IWA via dev proxy (`http://127.0.0.1:5173/`)
2. Open terminal (restty default on branch)
3. `seq 1 80` — two-finger scroll up over **terminal area** (not dbg panel)
4. **dbg → Scroll probe → Refresh → Copy** — check `mouse.active`, `wheelEvents`, `wheel-forward` / `wheel-unhijack` / `canvas-wheel` lines

## Suggested next steps

1. **Get runtime evidence** — device cannot reach `127.0.0.1:7889` ingest; rely on dbg Copy or run CDP locally (`scripts/run-spike-restty.mjs`) with scrollbar offset probe before/after wheel
2. **Log `event.target` + scrollbar offset** — expose via dbg HUD (restty has `restty_scrollbar_offset` WASM export; not on public API — may need internal hook or `debugExpose`)
3. **Canvas listener re-bind** — after `term.restty.getBackend()` settles, poll `root.querySelector('canvas')` identity and re-call `installScrollGuard` if canvas node changes
4. **Hit-test** — log whether wheel target is `CANVAS` vs `DIV.pane` vs `#terminal`; if always parent, fix forwarding or restty mount CSS
5. **Mouse mode** — if `mouse.active` true at shell prompt, test `term.restty.setMouseMode(...)` or always shift-unhijack
6. Do **not** change vendoring workflow unless spike passes device gate

## Key files

- `app/src/pwa/resttyAdapter.ts` — adapter + scroll guard + debug
- `app/src/pwa/views.ts` — renderer switch, debug HUD
- `app/src/pwa/styles.css` — restty layout, `touch-action: none` on canvas
- `app/src/ssh/NasshCommandBridge.ts` — resize subscription
- `scripts/spike-restty.mjs`, `scripts/run-spike-restty.sh`
