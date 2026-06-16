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
│  │ NasshSession    │─────▶│ DirectSocketTransport   │  │
│  │ (wassh bridge)  │      │ (TCPSocket / IWA perm)  │  │
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
| SSH session | `app/src/ssh/` | `NasshSession` + `DirectSocketTransport` |
| Persistence | `app/src/storage/` | Profiles, settings, identities, known hosts |
| Upstream | `upstream/libapps/` | Chromium libapps (nassh/wassh) |

## Development

```bash
npm install
npm run dev      # Vite dev server → http://localhost:5173
npm run build    # typecheck + production bundle → dist/
npm run typecheck
npm run preview  # serve dist/ locally
```

**IWA install on ChromeOS** (Direct Sockets, signed bundle): see [docs/IWA_DEV_SETUP.md](docs/IWA_DEV_SETUP.md).

**Upstream nassh/wassh build and submodule:** see [docs/UPSTREAM_NASSH_NOTES.md](docs/UPSTREAM_NASSH_NOTES.md).

Initialize the libapps submodule:

```bash
git submodule update --init --depth 1 upstream/libapps
```

## MVP status & roadmap

| Phase | Focus | Status |
|-------|-------|--------|
| **0** | Repo bootstrap, app shell, echo stub session, Direct Sockets scaffold | Done (dev server + unsigned bundle) |
| **1** | Upstream libapps build; wire wassh + `DirectSocketTransport` | Not started |
| **2** | Terminal adapter, xterm.js, session I/O, resize/window-change | Partial (adapter + xterm UI; wassh I/O pending) |
| **3** | Profiles, connect screen, settings shell | Done (IndexedDB, connect, profiles, settings) |
| **4** | Tabbed manifest, appearance/keyboard settings, known_hosts, key import | Partial (manifest + settings UI; trust UI + keys pending) |
| **5** | E2E smoke tests (vim/tmux/fish), signed bundle, security notes | Partial (docs + unsigned bundle script) |

Track work on the [issue tracker](https://github.com/esko/iwa-ssh/issues).

## License

Upstream libapps is Chromium-licensed. See submodule tree for details.
