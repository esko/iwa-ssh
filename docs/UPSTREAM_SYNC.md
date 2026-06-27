# Upstream Sync

This repo copies selected Chromium libapps assets into `app/upstream/` so the IWA can serve nassh/wassh runtime files from its own origin.

## Sources

- `upstream/libapps/terminal/`
- `upstream/libapps/nassh/`
- `upstream/libapps/wassh/`
- `upstream/libapps/wasi-js-bindings/`
- `upstream/libapps/ssh_client/` plugin output
- Eternal Terminal protobuf schemas pinned by `scripts/fetch-et-protocol.mjs`

Initialize or refresh the submodule first:

```bash
git submodule update --init --depth 1 upstream/libapps
```

## Generated Assets

`scripts/fetch-upstream-assets.mjs` owns files under `app/upstream/`.

It must copy or generate:

- nassh JavaScript needed by `CommandInstance`
- nassh locales needed at runtime
- wassh JavaScript, including `wassh/js/sockets.js`
- WASI JS bindings
- OpenSSH plugin WASM
- `mosh-client.wasm`
- an asset manifest with source paths and sizes

Run:

```bash
npm run fetch-assets
```

Refresh the ET v6 schemas and their checked-in TypeScript codecs separately:

```bash
npm run fetch:et-protocol
```

The command should be repeatable. It should fail loudly when required upstream inputs are missing or when a documented patch can no longer be applied.

## Local Patch Rules

Do not hand-edit generated upstream files as normal application code. If a copied upstream file must differ:

1. Add a named patch function or transform in `scripts/fetch-upstream-assets.mjs`.
2. Document the reason in this file.
3. Keep the patch as small and searchable as possible.
4. Include a drift check so upstream changes fail the fetch instead of silently producing a broken asset.

Allowed patch reasons:

- IWA/Direct Sockets compatibility.
- Runtime URL adaptation for assets served from `/upstream/`.
- Chrome API polyfills that cannot live outside the copied file.
- Mosh or socket behavior required by upstream nassh/wassh in an IWA.

Forbidden patch reasons:

- Product UI customization.
- Debug shortcuts.
- Profile or settings behavior.
- Terminal emulator behavior.
- Changes that should live in a local adapter module.

## Restty Renderer Patch

Restty is a separately pinned renderer dependency under `vendor/restty/`, not a
copied libapps asset. `scripts/restty-renderer-patches.ts` contains one temporary
Vite transform for Restty 0.1.37. Powerline triangles used endpoint-inclusive
sampling, drawing their final one-pixel row at `cellTop + cellHeight` (outside
the cell) while leaving rounding-dependent gaps between rows. Filled Powerline
half circles (`U+E0B4` and `U+E0B6`) had no procedural cases at all, so they
fell back to font-atlas glyph constraints that could leave a seam against the
adjacent colored cell. The transform samples pixel centers, writes exactly one
row per rounded cell-height pixel, and draws the filled half circles from the
cell boundary. It fails the build if the pinned bundle changes, and should be
removed when the next pinned Restty release includes the upstream corrections.

## Restty Pane DOM Dependency

Restty exposes no public pane resize or maximize API. The keyboard pane
**resize** (`Ctrl+Alt+Arrow`) and **zoom** (`Ctrl+Shift+Z`) features in
`app/src/pwa/resttyAdapter.ts` therefore reach into Restty's internal split DOM:

- Resize reads and writes the inline `flex: 0 0 <pct>%` sizing that Restty puts
  on the two children of each `.pane-split` node (`.is-vertical` /
  `.is-horizontal`), mirroring Restty's own divider-drag math.
- Zoom overlays the active `.pane[data-pane-id]` container with
  `position:absolute; inset:0`, which assumes `.pane-split` ancestors are
  unpositioned so the overlay anchors to the terminal root.

Unlike the renderer patch above there is **no build-time drift check** for this —
it is runtime adapter code. When bumping `vendor/restty/`, re-verify that the
`.pane` / `.pane-split` / `.pane-divider` class names and the `flex: 0 0 <pct>%`
sizing scheme still hold, and smoke-test directional focus, resize, and zoom with
at least three split panes. Pane focus/navigation uses Restty's public
`setActivePane(id, { focus })` and is not at risk.

## Refresh Procedure

1. Update `upstream/libapps` to the chosen commit.
2. Read relevant upstream changelog or source changes.
3. Run `npm run fetch-assets`.
4. Inspect `git diff -- app/upstream scripts/fetch-upstream-assets.mjs`.
5. Run `npm run typecheck`.
6. Run `npm run build`.
7. Smoke SSH in an installed IWA.
8. Smoke Mosh when UDP and `mosh-server` are available.
9. Update `docs/TEST_PLAN.md` with exact versions, commands, and results.

## Current Patch Ledger

Keep this ledger current as generated patches are added:

| Patch | Owner | Reason | Drift check |
| --- | --- | --- | --- |
| wassh Direct Sockets adaptation | `scripts/fetch-upstream-assets.mjs` | IWA socket compatibility | fetch script should verify expected socket symbols before patching |
| wassh TTY pixel dimensions | `scripts/fetch-upstream-assets.mjs` | Populate `TIOCGWINSZ` pixels for terminal image clients such as `kitten icat` | exact upstream zero-pixel block must match before replacement |
| nassh locale/bootstrap adaptation | `scripts/fetch-upstream-assets.mjs` and `app/src/ssh/` | Runtime messages without extension packaging | typecheck and SSH smoke |
| Restty pane resize/zoom DOM access | `app/src/pwa/resttyAdapter.ts` | No public Restty resize/maximize API; drives `.pane-split` inline `flex` and a `.pane` overlay | manual: focus/resize/zoom with 3+ split panes after a Restty bump (no automated check) |
