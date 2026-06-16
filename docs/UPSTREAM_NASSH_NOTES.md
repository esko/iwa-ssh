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

Integration point: `NasshSession` delegates to `NasshCommandBridge` → upstream `CommandInstance` for I/O while the adapter handles display/input/resize.

### Identity keys (IWA)

Upstream `connectTo` accepts `identity` (basename under `/.ssh/identity/`). `NasshCommandBridge` stages keys from our IndexedDB `identities` store into nassh's indexeddb-fs (`nasshIdentity.ts`) before connect. Passphrase-protected PEM uses `SecureInputPrompt` via nassh `secureInput`.

Not wired yet: syncing our IndexedDB `knownHosts` into nassh's `/.ssh/known_hosts` (host-key prompts remain stubbed in `KnownHostPrompt.ts`).

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

### Phase 1: fetch assets into `app/public/upstream/`

Copied assets are served by Vite at `/upstream/…` (from `app/public/upstream/`). Run after submodule init:

```bash
# 1. Submodule (once)
git submodule update --init --depth 1 upstream/libapps

# 2. Download OpenSSH WASM plugin (or let fetch-assets do it)
cd upstream/libapps/nassh && ./bin/plugin && cd ../../..

# 3. Copy wassh worker + WASI bindings + plugin WASM into public/
npm run fetch-assets
```

`npm run fetch-assets` runs `scripts/fetch-upstream-assets.mjs`, which:

1. Executes `upstream/libapps/nassh/bin/plugin` when possible (downloads `0.77.tar.xz` from ChromeOS localmirror per `nassh/fetch.json`)
2. Copies JS/WASM into `app/public/upstream/` preserving libapps-relative import paths
3. Writes `app/public/upstream/manifest.json` and prints a file manifest

**Example manifest output** (truncated; full list is 200+ files):

```text
Copied upstream asset manifest:
────────────────────────────────────────────────────────────────────────
  2132.9 KiB  plugin/wasm/ssh.wasm
     1.2 KiB  wassh/js/worker.js
    56.1 KiB  nassh/js/nassh_command_instance.js
     0.9 KiB  libdot/index.js
     1.2 KiB  hterm/index.js
    31.9 KiB  manifest.json
    …
────────────────────────────────────────────────────────────────────────
217 file(s), 17682.9 KiB total → app/public/upstream/
```

`manifest.json` fields:

| Field | Example |
|-------|---------|
| `generatedAt` | ISO timestamp |
| `upstreamBase` | `/upstream` |
| `workerUrl` | `/upstream/wassh/js/worker.js` |
| `pluginBase` | `/upstream/plugin` |
| `defaultSshWasm` | `/upstream/plugin/wasm/ssh.wasm` |
| `nasshCommandUrl` | `/upstream/nassh/js/nassh_command_instance.js` |
| `files` | `{ dest, bytes, source }[]` per copied file |

Runtime helpers in `app/src/ssh/upstreamAssets.ts`: `areUpstreamAssetsReady()`, `getWasshWorkerUrl()`, `getPluginBase()`.

**Layout after a successful fetch:**

```text
app/public/upstream/
  manifest.json
  wassh/js/
    worker.js          # module worker entry (imports wasi-js-bindings)
    process.js, sockets.js, syscall_*.js, vfs.js, constants.js, …
  wasi-js-bindings/
    index.js
    js/…               # WASI runtime used by the worker
  plugin/
    .hash
    wasm/
      ssh.wasm         # default OpenSSH client (nassh sshClientVersion_ = "wasm")
      scp.wasm, sftp.wasm, mosh-client.wasm, ssh-keygen.wasm
    wasm-openssh-8.6/  # alternate plugin tree (--ssh-client-version)
      ssh.wasm, …
```

**Vite worker / plugin URLs** (defined in `vite.config.ts` for Phase 2 wiring):

| Constant | Value |
|----------|-------|
| `__IWA_UPSTREAM_BASE__` | `/upstream` |
| `__IWA_WASSH_WORKER_URL__` | `/upstream/wassh/js/worker.js` |
| `__IWA_PLUGIN_BASE__` | `/upstream/plugin` |
| `__IWA_DEFAULT_SSH_WASM__` | `/upstream/plugin/wasm/ssh.wasm` |

If `bin/plugin` or the submodule is unavailable, `fetch-assets` writes a stub tree under `app/public/upstream/` with `README.md` and `.gitkeep` placeholders (exit code 1).

**Vite serving:** dev/preview set `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (required for `SharedArrayBuffer` in wassh). The `iwa-upstream-asset-headers` plugin in `vite.config.ts` also forces `Content-Type: application/wasm` for `/upstream/**/*.wasm`.

### Long-term build plan

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
