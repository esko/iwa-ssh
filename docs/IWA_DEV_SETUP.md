# IWA development setup

Personal-use **local-only** Isolated Web App for ChromeOS SSH. No web server hosting, no update CDN, no `example.com` URLs. Requires **Chrome or ChromeOS 120+**.

## Official references

Use these before debugging Gosh install or TCP issues:

| Resource | Role |
|----------|------|
| [Getting started with IWAs](https://chromeos.dev/en/tutorials/getting-started-with-isolated-web-apps) | End-to-end tutorial (uses Kitchen Sink) |
| [IWA Kitchen Sink](https://github.com/chromeos/iwa-sink) (`chromeos/iwa-sink`) | Reference app — Direct Sockets tab, manifest, signed-bundle releases |
| [Telnet client](https://github.com/GoogleChromeLabs/telnet-client) | Minimal Direct Sockets terminal (closest analogue to SSH) |
| [Direct Sockets (Chrome docs)](https://developer.chrome.com/docs/iwa/direct-sockets) | Required `permissions_policy`, `TCPSocket` usage, DevTools from Chrome 138+ |
| [moshtty (legacy PWA)](https://github.com/esko/moshtty/tree/legacy-pwa) | Our earlier ChromeOS terminal with **working native tabbed mode** (`display_override: tabbed` + `tab_strip`) as a multi-page PWA. Tab-behavior precedent; PWA (not IWA), multi-page (not SPA) |

Gosh’s manifest `permissions_policy` matches Kitchen Sink / Telnet for TCP SSH targets:

```json
"permissions_policy": {
  "cross-origin-isolated": ["self"],
  "direct-sockets": ["self"],
  "direct-sockets-private": ["self"],
  "local-network": ["self"],
  "loopback-network": ["self"]
}
```

Per the [Direct Sockets doc](https://developer.chrome.com/docs/iwa/direct-sockets): `cross-origin-isolated` is required for all IWAs; `direct-sockets` enables `TCPSocket`; private/local/loopback keys cover LAN and RFC1918 targets.

## First SSH test on ChromeOS (Dev Mode Proxy)

One-time setup, then a repeatable smoke path. No hosting or `.swbn` required.

### One-time

1. `chrome://flags/#enable-isolated-web-app-dev-mode` → **Enabled** → restart Chrome
2. Also enable `chrome://flags/#enable-isolated-web-apps` if present (required on some channels)
3. In Crostini (or Linux on Chromebook): clone repo, `npm install`, `git submodule update --init upstream/libapps`, `npm run fetch-assets`
4. Optional: `chrome://flags/#enable-direct-sockets-for-isolated-web-apps` if TCPSocket is missing after install

### Sanity-check: install a reference IWA first

If install fails with *“manifest could not be fetched, parsed…”*, verify flags + Dev Mode Proxy with a known-good app:

| Example | What it proves | How to try |
|---------|----------------|------------|
| [IWA Kitchen Sink](https://github.com/chromeos/iwa-sink) | Full IWA stack + **Direct Sockets** demo UI | Follow [getting started tutorial](https://chromeos.dev/en/tutorials/getting-started-with-isolated-web-apps); or install signed bundle from [releases](https://github.com/chromeos/iwa-sink/releases) via Web App Internals |
| [Telnet client](https://github.com/GoogleChromeLabs/telnet-client) | Raw TCP terminal over Direct Sockets | `npm install && npm run start` → Dev Mode Proxy → `http://127.0.0.1:4321/` |
| [IWA Bundling Example](https://github.com/michaelwasserman/iwa-bundling-example) | Minimal manifest + install path | `cd static && python3 -m http.server 8765` → `http://127.0.0.1:8765/` |

Install steps (same for any dev-proxy example):

1. Start the example’s dev/static server
2. `chrome://web-app-internals` → **Install IWA with Dev Mode Proxy**
3. Paste `http://127.0.0.1:<port>/` (trailing slash)

Kitchen Sink’s Direct Sockets tab is the best place to confirm `TCPSocket` works on your Chromebook before testing Gosh.

CLI install (Linux/Crostini alternative to Web App Internals — Chrome must be fully quit first):

```bash
google-chrome --enable-features=IsolatedWebApps,IsolatedWebAppDevMode \
  --install-isolated-web-app-from-url=http://127.0.0.1:5173/
```

### Each test session

1. `npm run dev` — Vite on `http://127.0.0.1:5173` (keep terminal open)
2. `chrome://web-app-internals` → **Install IWA with Dev Mode Proxy**
3. URL: `http://127.0.0.1:5173/` (prefer `127.0.0.1` over `localhost`)
4. Launch **Gosh** from the app launcher (not a normal browser tab)
5. Open **Debug** (`/debug`) — confirm **TCPSocket** = yes, **Upstream assets** = ready, **IWA origin** = yes
6. **Connect** → enter host, port, username → accept host-key prompt if shown
7. Terminal shows a shell prompt; run `echo ok` on the remote host

### After code changes

Dev Mode Proxy serves your **live** Vite server — you usually do **not** need Force update check for JS/CSS edits:

1. Keep `npm run dev` running
2. Save files in the repo
3. Close the Gosh window and reopen it from the launcher (or hard-refresh if the window allows)

**Force update check** only runs when `version` in `/.well-known/manifest.webmanifest` **increases** (e.g. `0.1.0` → `0.1.1`). If you see *“Installed app is already on version …”*, that is normal — the version did not change.

| Situation | What to do |
|-----------|------------|
| Edited app code (routes, SSH, UI) | Save → close/reopen Gosh (Vite must be running) |
| Changed manifest, icons, or boot/trusted-types | Bump `version` in both manifest files, restart `npm run dev`, then **Force update check** |
| Still broken / black screen | Web App Internals → remove dev install → **Install IWA with Dev Mode Proxy** again at `http://127.0.0.1:5173/` |
| Changed dev server port | Reinstall Dev Mode Proxy with the new URL |

### Quick checks if SSH fails

| Check | Expected |
|-------|----------|
| Installed via Dev Mode Proxy | `isolated-app://…` origin on `/debug` |
| `TCPSocket` on `/debug` | yes |
| Upstream assets | ready (`npm run fetch-assets`) |
| Target host | reachable on port 22 from the Chromebook |

See [tests/e2e/README.md](../tests/e2e/README.md) for terminal UI smoke tests and [tests/e2e/smoke-terminal.spec.md](../tests/e2e/smoke-terminal.spec.md) for vim/tmux/fish once SSH is wired.

## Local-only workflow (recommended)

You have two ways to run this on your Chromebook — both stay on the machine:

| Mode | When to use | How |
|------|-------------|-----|
| **Dev Mode Proxy** | Daily development | `npm run dev` → install `http://127.0.0.1:5173` via Web App Internals |
| **Signed `.swbn`** | Stable install without Vite running | `npm run bundle:iwa` → pick `dist/gosh.swbn` from disk in Web App Internals |

You do **not** need:

- `update_manifest_url` in the manifest (omit it for local use)
- Hosting `update-manifest.json` anywhere
- A public HTTPS origin for the app bundle

To refresh after code changes:

- **Dev proxy:** save files; Vite hot-reloads (or re-open the app)
- **Signed bundle:** `npm run bundle:iwa` again → reinstall the new `.swbn` from `dist/`

## Prerequisites

- ChromeOS device (or Chrome with IWA dev mode for limited testing)
- Node.js 20+ and `npm install` in this repo
- For signed-bundle install: OpenSSL (for signing keys)

## Enable IWA dev mode

1. Open `chrome://flags/#enable-isolated-web-app-dev-mode`
2. Set to **Enabled**
3. Restart Chrome

Optional flags while developing:

| Flag | Purpose |
|------|---------|
| `#enable-isolated-web-apps` | Base IWA feature gate (enable if install fails) |
| `#enable-isolated-web-app-dev-mode` | Required for local IWA install |
| `#enable-direct-sockets-for-isolated-web-apps` | Direct Sockets in IWAs (if not default on your channel) |

## chrome://web-app-internals

Open `chrome://web-app-internals` — central page for installing and debugging IWAs.

Two install paths:

### A. Dev Mode Proxy (day-to-day development)

Best for iterating without rebuilding `.swbn` on every change.

1. `npm run dev` (Vite on `http://127.0.0.1:5173`)
2. On **Web App Internals**, choose **Install IWA with Dev Mode Proxy**
3. Enter `http://127.0.0.1:5173/` (use `127.0.0.1`, not `localhost`, if Chrome is picky)
4. Chrome assigns a random `isolated-app://` identity for this dev install

The proxy serves your live dev server inside the IWA security model so `TCPSocket` and other IWA APIs are available.

**Caveats:**

- Dev proxy identity changes between installs — not suitable for production updates
- App must meet IWA requirements (COOP/COEP headers, CSP, no server-rendered pages)
- Use **Force update check** on Web App Internals to refresh after server restarts

### B. Signed Web Bundle (local file install)

Use this when you want a normal app-launcher icon without keeping `npm run dev` running.

1. `npm run bundle:iwa` (builds `dist/`, signs if you have a key — see below)
2. On **Web App Internals**, choose **Install IWA from Signed Web Bundle**
3. Select `dist/gosh.swbn` from this repo on disk (USB, Downloads, home directory — anywhere local)

Identity is stable when signed — tied to your Ed25519 key (Web Bundle ID).

## Signing keys and first signed bundle

Keys under `iwa/keys/*.pem` are **gitignored** — never commit private keys.

### Dev vs release keys

| Key | Purpose | Where to keep |
|-----|---------|---------------|
| **Dev key** | Personal Chromebook testing, frequent rebuilds | `iwa/keys/encrypted_key.pem` on your machine only |
| **Release key** | Stable app identity for installs you care about long-term | Offline backup (password manager, encrypted USB) — **not** in the repo |

Each key defines a unique **Web Bundle ID** (`isolated-app://…` origin). Reinstalling with the **same** key keeps the same app identity; a **new** key creates a different app in the launcher.

Use a dev key while iterating. Switch to a release key only when you want a stable identity — generate it once, back it up, then run the workflow below.

### Step-by-step: first signed bundle

1. **Generate a dev signing key** (prompts for a PEM encryption passphrase):

   ```bash
   npm run iwa:keygen
   ```

   This creates `iwa/keys/encrypted_key.pem` and runs `npm run iwa:update-id` to patch `webBundleId` in `iwa/webbundle.config.ts`.

2. **Set the signing passphrase** for non-interactive builds (same passphrase you chose during `pkcs8` encryption):

   ```bash
   export WEB_BUNDLE_SIGNING_PASSPHRASE='your-passphrase'
   ```

   Add to your shell profile only on machines you trust. Never commit this value.

3. **Build and sign**:

   ```bash
   npm run bundle:iwa
   ```

   Output: `dist/gosh.swbn` (signed) and `dist/gosh.unsigned.wbn` (intermediate).

4. **Verify bundle metadata** (optional):

   ```bash
   npm run bundle:iwa:info
   ```

5. **Install** — see [Install steps summary (.swbn)](#install-steps-summary-swbn) below.

### Unsigned-only builds

For CI or packaging without a key:

```bash
npm run bundle:iwa:unsigned
```

Uses a placeholder `isolated-app://` origin until `webBundleId` is set. Fine for checking the build; not installable as a real IWA until signed with a matching key and ID.

### Manual key generation (alternative)

```bash
mkdir -p iwa/keys
openssl genpkey -algorithm Ed25519 -out iwa/keys/private_key.pem
openssl pkcs8 -in iwa/keys/private_key.pem -topk8 -out iwa/keys/encrypted_key.pem
rm iwa/keys/private_key.pem   # keep only encrypted key
npm run iwa:update-id
WEB_BUNDLE_SIGNING_PASSPHRASE='…' npm run bundle:iwa
```

### `WEB_BUNDLE_SIGNING_PASSPHRASE`

- Required for `npm run bundle:iwa` when `encrypted_key.pem` is passphrase-protected (default from `openssl pkcs8 -topk8`).
- Passed to `wbn-sign` via `--password-env WEB_BUNDLE_SIGNING_PASSPHRASE`.
- Omit only if your PEM is unencrypted (not recommended).

### Bundle headers

IWA-required COOP/COEP/CORP/CSP headers are embedded via `headerOverride` in `iwa/webbundle.config.ts` and passed to `wbn` during `bundle:iwa`. Keep CSP in sync with `docs/SECURITY.md`.

## Direct Sockets debugging

See [Direct Sockets (Chrome docs)](https://developer.chrome.com/docs/iwa/direct-sockets) for manifest requirements and API usage.

From **Chrome 138+**, Direct Sockets traffic appears in DevTools **Network** panel when inspecting the IWA:

1. Open the IWA window
2. Right-click → **Inspect** (or DevTools from Web App Internals)
3. Network tab → filter for socket / Direct Sockets entries

Useful for verifying TCP connect, read/write timing, and abort behavior.

If `TCPSocket` is undefined:

- Confirm IWA dev mode is enabled
- Confirm install via Dev Mode Proxy or signed bundle (not a normal browser tab)
- Check `permissions_policy` includes `direct-sockets`, `cross-origin-isolated`, and LAN keys (`direct-sockets-private`, `local-network`, `loopback-network`) — see [Direct Sockets doc](https://developer.chrome.com/docs/iwa/direct-sockets)

## Local workflow

```bash
npm install
npm run dev          # dev server
npm run build        # production dist/
npm run bundle:iwa   # dist/ + .swbn packaging (signs if key present)
npm run bundle:iwa:unsigned  # unsigned .wbn only
npm run bundle:iwa:info      # show signed bundle integrity block
npm run iwa:keygen   # generate Ed25519 signing key + update webBundleId
npm run iwa:update-id  # re-derive webBundleId from existing key
npm run smoke:e2e    # SSH fixture + CDP echo checks
npm run typecheck
```

## Install steps summary (.swbn)

```text
1. npm run iwa:keygen          → iwa/keys/encrypted_key.pem + webBundleId
2. export WEB_BUNDLE_SIGNING_PASSPHRASE='…'
3. npm run bundle:iwa            → dist/gosh.swbn
4. chrome://flags → enable IWA dev mode → restart
5. chrome://web-app-internals → Install from Signed Web Bundle
6. Select dist/gosh.swbn
7. Launch from app launcher; npm run bundle:iwa:info to inspect
```

## Updates (local only)

For personal local use, **skip remote updates entirely**. When you change the app:

1. Rebuild: `npm run bundle:iwa`
2. Reinstall the new `.swbn` from **Web App Internals** (same signing key → same app identity)

`iwa/update-manifest.json` is an optional template for people who later self-host updates. This project does not use it by default.

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Install fails: icon downloading | Manifest icons must be **PNG** with explicit `sizes` (`192x192`, `512x512`); SVG-only fails |
| Black screen after install | Trusted Types blocks `innerHTML` without a default policy — fixed in `app/src/security/trustedTypes.ts`. Restart `npm run dev`, close/reopen app, or reinstall Dev Mode Proxy |
| Force update: “already on version …” | Expected when manifest `version` unchanged — close/reopen the app for code changes, or bump `version` then Force update, or reinstall |
| `TCPSocket` unavailable | Installed via Dev Mode Proxy (not a browser tab); manifest needs full `permissions_policy` (see [Direct Sockets doc](https://developer.chrome.com/docs/iwa/direct-sockets)) |
| Integrity Block V1 error | Re-sign with current `wbn-sign` (V2 required since M129) |
| xterm blank/broken in prod build | Vite re-minifying xterm — see `vite.config.ts` `optimizeDeps.exclude` |
| Different app after re-signing with new key | Web Bundle ID changes with key — expected |
