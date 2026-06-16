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
│  wassh (OpenSSH WASM) + DirectSocketTransport (TCPSocket)│
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
  TerminalAdapter.ts       # interface: open, write, onInput, onResize, focus, dispose
  Xterm6TerminalAdapter.ts # @xterm/xterm 6 + fit, web-links, search, clipboard
```

`NasshSession` bridges wassh I/O to the adapter (stdin/stdout, window-change on resize). hterm-specific UI and preferences are not carried over.

## Direct Sockets transport

`DirectSocketTransport.ts` wraps the IWA `TCPSocket` API and exposes a read/write handle for wassh:

- `openDirectTcpSocket({ host, port, signal })` → `{ read, write, close }`
- Requires IWA install with `direct-sockets` permission (ChromeOS 120+)
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
| `identities` | SSH keys (private key as encrypted `ArrayBuffer`) |
| `knownHosts` | Host key fingerprints (`host:port` key) |

`exportData()` produces JSON for backup (private key material omitted; `hasEncryptedPrivateKey` flag only).

## Build output

- **Dev:** Vite serves `app/` on port 5173; use IWA Dev Mode Proxy for Direct Sockets.
- **Prod:** `npm run build` → `dist/` static assets → `npm run bundle:iwa` → unsigned/signed `.swbn`.

Vite excludes xterm 6 from re-minification (`vite.config.ts`) — re-minifying breaks the terminal bundle.

## Phases (summary)

| Phase | Goal |
|-------|------|
| 0 | IWA + Direct Sockets + upstream build verified |
| 1 | xterm adapter wired to wassh session I/O |
| 2 | App shell, routes, tabbed manifest |
| 3 | Settings persistence, import/export |
| 4 | Security hardening (see [SECURITY.md](./SECURITY.md)) |
| 5 | Polish — reconnect overlay, search, command palette |

## Deferred

Mosh, SFTP UI, port forwarding, agent forwarding, passkeys, jump hosts, multi-pane splits.
