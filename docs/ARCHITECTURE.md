# Architecture

ChromeOS IWA SSH client. Keeps nassh/wassh for SSH; replaces hterm with an xterm.js 6 adapter; packages as a signed web bundle.

## Stack

```text
┌─────────────────────────────────────────────────────────┐
│  IWA window (tabbed PWA, isolated-app:// origin)        │
├─────────────────────────────────────────────────────────┤
│  Routes: /, /connect, /session/:id, /settings, /profiles│
├──────────────┬──────────────────────┬───────────────────┤
│  App shell   │  Xterm6TerminalAdapter│  Settings / UI   │
│  (router)    │  (TerminalAdapter)    │  (profiles, etc.)│
├──────────────┴──────────┬───────────┴───────────────────┤
│  NasshSession           │  IndexedDB (settings, profiles)│
├─────────────────────────┴───────────────────────────────┤
│  wassh (OpenSSH WASM) via nassh CommandInstance (Direct Sockets) │
└─────────────────────────┬───────────────────────────────┘
                          │ TCP :22
                          ▼
                    remote sshd
```

No proxy, Crostini daemon, or local shell. Direct Sockets only for MVP.

## What we keep from upstream libapps

| Component | Role |
|-----------|------|
| `wassh/` | WASI syscall bridge, socket abstraction, SSH client runtime |
| `ssh_client/` | OpenSSH compiled to WASM |
| `nassh/` (subset) | Session/command logic, known_hosts, identity/key handling |

See [UPSTREAM_NASSH_NOTES.md](./UPSTREAM_NASSH_NOTES.md) for build and integration details.

## What we replace

**hterm** → **`TerminalAdapter`** + **`Xterm6TerminalAdapter`**

```text
app/src/terminal/
  TerminalAdapter.ts       # interface: open, write, onInput/onResize (disposable), focus, dispose
  Xterm6TerminalAdapter.ts # @xterm/xterm 6 + fit, web-links, search, clipboard
```

`NasshSession` bridges wassh I/O to the adapter (stdin/stdout, window-change on resize). hterm-specific UI and preferences are not carried over.

### Phase 1: nassh session bridge (hterm.IO stub)

Upstream `CommandInstance` still expects `hterm.Terminal.IO`. We do not mount hterm UI; a stub terminal satisfies the API and pipes bytes through xterm:

```text
app/src/ssh/
  NasshSession.ts          # tries NasshCommandBridge, falls back to echo stub
  NasshCommandBridge.ts      # dynamic import upstream CommandInstance + connectTo
  HtermIoBridge.ts           # stub hterm.Terminal + hterm.Terminal.IO → TerminalAdapter
  upstreamAssets.ts          # HEAD checks for /upstream manifest + worker + wasm
  upstreamUrls.ts            # runtime import URLs (__IWA_UPSTREAM_BASE__)
```

| Direction | Path |
|-----------|------|
| SSH → screen | `stubTerminal.interpret` → `TerminalAdapter.write` → xterm |
| keyboard → SSH | xterm `onData` → `io.sendString` → wassh stdin (via disposable `onInput` subscriptions) |
| resize | `adapter.onResize` → `screenSize` + `io.onTerminalResize_` → SIGWINCH |
| passphrase | `CommandInstance.secureInput` → `prompt()` (MVP) |

Upstream JS is loaded at runtime from `app/public/upstream/` (`npm run fetch-assets`), not bundled by Vite. `vite.config.ts` defines worker/plugin URL constants; dev/preview set COOP/COEP for `SharedArrayBuffer` (wassh worker).

If assets are missing, `NasshSession` keeps the Phase 0 local echo stub so the session UI remains usable.

## Direct Sockets

SSH TCP is opened by upstream wassh inside nassh `CommandInstance` (`--field-trial-direct-sockets`).

`DirectSocketProbe.ts` is **not** the live transport — it exposes `isDirectSocketsAvailable()` and `openDirectTcpSocket()` for dev probes (e.g. `/debug`):

- Manifest `permissions_policy` per [Direct Sockets (Chrome docs)](https://developer.chrome.com/docs/iwa/direct-sockets) and [IWA Kitchen Sink](https://github.com/chromeos/iwa-sink)
- Requires IWA install with `direct-sockets` permission (ChromeOS 120+)
- Reference terminal client: [GoogleChromeLabs/telnet-client](https://github.com/GoogleChromeLabs/telnet-client)
- Upstream nassh 0.78+ enables Direct Sockets by default

UDP/Mosh paths exist upstream but are deferred in this fork.

## Routing

Hash-free history API router (`app/src/app-shell/router.ts`):

| Path | Purpose |
|------|---------|
| `/` | Home — recent profiles, quick actions |
| `/connect` | Connection form; `?profile=` pre-fills from saved profile |
| `/session/:id` | Full-window terminal session |
| `/settings` | Appearance, keyboard, behavior; `?popup=1` for popup window |
| `/profiles` | Profile manager |

Each SSH session is intended to run in a **native app tab** (`display_override: ["tabbed"]` in the web manifest), not an in-app tab strip.

Session connection params are passed via `sessionStorage` until wassh wiring is complete.

## Storage

IndexedDB database `iwa-ssh` (`app/src/storage/indexedDb.ts`):

| Store | Contents |
|-------|----------|
| `settings` | Single `AppSettings` record (`key: 'app'`) |
| `profiles` | SSH profiles, indexed by `lastConnectedAt` |
| `identities` | SSH keys (`privateKeyPemBytesDevOnly` — raw PEM until WebCrypto) |
| `knownHosts` | Host key fingerprints (`host:port` key); stub-era entries may be invalid |

`exportData()` produces JSON for backup (private key material omitted; `hasPrivateKeyDevOnly` flag only).

## Build output

- **Dev:** Vite serves `app/` on port 5173; use IWA Dev Mode Proxy for Direct Sockets.
- **Prod:** `npm run build` → `dist/` static assets → `npm run bundle:iwa` → unsigned/signed `.swbn`.

Vite excludes xterm 6 from re-minification (`vite.config.ts`) — re-minifying breaks the terminal bundle.

## Phases (summary)

| Phase | Goal |
|-------|------|
| 0 | IWA + Direct Sockets + upstream build verified |
| 1 | xterm adapter wired to wassh session I/O via hterm.IO stub + CommandInstance |
| 2 | App shell, routes, tabbed manifest |
| 3 | Settings persistence, import/export |
| 4 | Security hardening (see [SECURITY.md](./SECURITY.md)) |
| 5 | Polish — reconnect overlay, search, command palette |

## Deferred

Mosh, SFTP UI, port forwarding, agent forwarding, passkeys, jump hosts, multi-pane splits.
