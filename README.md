# iwa-ssh

ChromeOS **Isolated Web App (IWA)** SSH client. Reuses Chromium's **nassh/wassh** (OpenSSH in WASM) for the protocol stack and **xterm.js 6** for the terminal UI, with **Direct Sockets** (`TCPSocket`) for raw TCP instead of a browser extension relay.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  IWA shell (Vite + TypeScript)                          │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐ │
│  │ App router  │  │ Settings /   │  │ IndexedDB       │ │
│  │ home/connect│  │ profiles UI  │  │ profiles, keys  │ │
│  └──────┬──────┘  └──────────────┘  └─────────────────┘ │
│         │                                               │
│  ┌──────▼──────────────────────────────────────────┐   │
│  │ TerminalAdapter  ←→  Xterm6TerminalAdapter       │   │
│  └──────┬──────────────────────────────────────────┘   │
│         │                                               │
│  ┌──────▼──────────┐      ┌─────────────────────────┐  │
│  │ NasshSession    │─────▶│ wassh via nassh (Direct Sockets) │  │
│  │ (wassh bridge)  │      │ DirectSocketProbe = dev checks   │  │
│  └─────────────────┘      └─────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
         ▲
         │ upstream/libapps (git submodule)
         │ nassh · wassh · libdot
```

| Layer | Location | Notes |
|-------|----------|-------|
| UI / routing | `app/src/app-shell/`, `app/src/routes/` | Hash-free client router |
| Terminal | `app/src/terminal/` | `TerminalAdapter` + xterm.js 6 |
| SSH session | `app/src/ssh/` | `NasshSession` + `NasshCommandBridge` (wassh via Direct Sockets) |
| Persistence | `app/src/storage/` | Profiles, settings, identities, known hosts |
| Upstream | `upstream/libapps/` | Chromium libapps (nassh/wassh) |

## Development

```bash
npm install
npm run dev      # Vite dev server → http://localhost:5173
npm run dev:chrome  # Vite + Chrome on /debug (CDP port 9222)
npm run build    # typecheck + production bundle → dist/
npm run typecheck
npm run preview  # serve dist/ locally
```

**IWA install on ChromeOS** (local only — Dev Mode Proxy or `.swbn` from disk): see [docs/IWA_DEV_SETUP.md](docs/IWA_DEV_SETUP.md). Reference apps: [IWA Kitchen Sink](https://github.com/chromeos/iwa-sink), [Telnet client](https://github.com/GoogleChromeLabs/telnet-client). Direct Sockets: [Chrome docs](https://developer.chrome.com/docs/iwa/direct-sockets).

**Upstream nassh/wassh build and submodule:** see [docs/UPSTREAM_NASSH_NOTES.md](docs/UPSTREAM_NASSH_NOTES.md).

Initialize the libapps submodule:

```bash
git submodule update --init --depth 1 upstream/libapps
```

## MVP status & roadmap

| Phase | Focus | Status |
|-------|-------|--------|
| **0** | Repo bootstrap, app shell, echo stub session, Direct Sockets probe | Done |
| **1** | Upstream libapps assets; wire nassh CommandInstance + wassh | Done (IWA verify on ChromeOS) |
| **2** | Terminal adapter, xterm.js 6 beta, session I/O, resize/window-change | Done |
| **3** | Profiles, connect screen, settings shell | Done |
| **4** | Tabbed manifest, appearance/keyboard settings, known_hosts, key import | Mostly done (native tabs need signed IWA install) |
| **5** | E2E smoke tests (vim/tmux/fish), signed bundle, security notes | Partial (smoke runner + bundle scripts; manual vim/tmux/fish) |

Track work on the [issue tracker](https://github.com/esko/iwa-ssh/issues).

Security model and threat assumptions: [docs/SECURITY.md](docs/SECURITY.md).

## License

Upstream libapps is Chromium-licensed. See submodule tree for details.
