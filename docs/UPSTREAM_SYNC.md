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
| nassh locale/bootstrap adaptation | `scripts/fetch-upstream-assets.mjs` and `app/src/ssh/` | Runtime messages without extension packaging | typecheck and SSH smoke |
