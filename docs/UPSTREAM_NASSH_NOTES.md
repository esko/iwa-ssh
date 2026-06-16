# Upstream libapps / nassh notes

`upstream/libapps` is a git submodule pointing at [chromium libapps](https://chromium.googlesource.com/apps/libapps).

```bash
git submodule update --init --depth 1 upstream/libapps
```

If submodule init fails (network, googlesource access):

```bash
git clone --depth 1 https://chromium.googlesource.com/apps/libapps upstream/libapps
```

## What we keep

```text
upstream/libapps/
  wassh/              # WASM SSH client runtime, socket layer, WASI bridge
  wasi-js-bindings/   # WASI ↔ JS bindings (wassh dependency)
  ssh_client/         # OpenSSH → WASM build
  nassh/              # Session logic, profiles, known_hosts, identities (subset)
  libdot/             # Shared utilities (nassh dependency)
```

**Keep and wire:**

- `wassh/js/sockets.js` — socket abstraction; Direct Sockets backend (`WebTcpSocket`)
- `wassh/js/syscall_*.js`, `worker.js`, `process.js` — WASM runtime
- `ssh_client/` output — OpenSSH WASM plugin copied into nassh
- `nassh/` connection/session code — host key checks, auth flow, command instances

**Do not port:**

- `hterm/` — replaced by `app/src/terminal/Xterm6TerminalAdapter.ts`
- `nassh` HTML UI, extension popup, crosh integration
- Chrome extension APIs (`chrome.sockets`, `terminalPrivate`, etc.) — use Direct Sockets instead

## What we replace

| Upstream | This repo |
|----------|-----------|
| hterm terminal | `TerminalAdapter` + `Xterm6TerminalAdapter` |
| `chrome.sockets` / relay | `DirectSocketTransport` (`TCPSocket`) |
| Extension manifest | IWA signed web bundle + `manifest.webmanifest` |
| `nassh` preferences UI | `/settings` route + IndexedDB |

Integration point: `NasshSession` should delegate to wassh for I/O while the adapter handles display/input/resize.

## Building Secure Shell (upstream)

From `upstream/libapps/nassh/`:

```bash
# 1. Build libdot + hterm deps (hterm built but not used in our UI)
./bin/mkdeps

# 2. OpenSSH WASM plugin — pick one:
./bin/plugin                    # download prebuilt plugin
# OR build from ssh_client:
cd ../ssh_client && <build> && cp -a output/plugin/ ../nassh/

# 3. Load unpacked extension (upstream workflow)
# chrome://extensions → Developer mode → Load unpacked → nassh/
```

See `upstream/libapps/nassh/docs/hack.md` for the full developer guide.

Dev extension ID is controlled by `key` in `manifest.json` — required for `chrome.sockets` on upstream; **not used** in our IWA fork.

## Direct Sockets in upstream

nassh **0.78** (2026-06-04) enables Direct Sockets by default. Relevant paths:

- `wassh/js/sockets.js` — `WebTcpSocket` backed by `TCPSocket`
- `nassh/webapp_manifest.json` — `permissions_policy.direct-sockets`

Our `DirectSocketTransport.ts` mirrors the browser API surface wassh expects.

## Building for this fork

Long-term build plan:

1. Build/copy `ssh_client` WASM plugin into a path Vite can import or serve from `app/public/`
2. Bundle wassh JS modules (or pre-build with Rollup) alongside the Vite app
3. Replace wassh socket backend registration with `DirectSocketTransport`

Short-term (Phase 0): verify upstream nassh connects over Direct Sockets when installed as upstream IWA/PWA before merging into this UI.

## Submodule updates

```bash
cd upstream/libapps
git fetch origin
git checkout <tag-or-commit>
cd ../..
git add upstream/libapps
```

Pin to a known-good nassh version (check `nassh/docs/ChangeLog.md`). Test SSH connect after every bump.

## Licenses

libapps components are BSD-style (see per-directory `LICENSE`). xterm.js is MIT. Respect upstream `third_party/` notices when shipping the `.swbn`.
