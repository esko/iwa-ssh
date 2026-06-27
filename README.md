# Gosh

ChromeOS Isolated Web App terminal client. The project is being reset into a near-upstream port of Google Terminal + nassh, with upstream behavior as the default and a small set of documented local deltas.

Primary upstream references:

- Google Terminal: https://chromium.googlesource.com/apps/libapps/+/HEAD/terminal/
- nassh: https://chromium.googlesource.com/apps/libapps/+/HEAD/nassh/
- wassh: `upstream/libapps/wassh/`

## Reset Direction

The app should follow Google Terminal/nassh architecture unless IWA packaging or Direct Sockets requires an adaptation.

Allowed local deltas:

- xterm.js `6.1.0-beta` with kitty keyboard protocol support.
- Arbitrary terminal font family strings, including Nerd Fonts.
- Stronger theme, scrollback, and renderer/performance controls.
- Mosh support through upstream nassh/wassh.

Everything else should be upstream-shaped by default. Custom SSH-manager flows, simulated tabs, debug-first screens, fixture-specific UX, and bespoke dashboards are not reset goals.

See:

- [Reset PRD](docs/RESET_PRD.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Upstream Sync](docs/UPSTREAM_SYNC.md)
- [Terminal Deltas](docs/TERMINAL_DELTAS.md)
- [Mosh](docs/MOSH.md)
- [Test Plan](docs/TEST_PLAN.md)
- [Agent Guide](docs/AGENT_GUIDE.md)

## Architecture

```text
IWA terminal shell
  home, SSH/Mosh launch, profiles, settings, sessions
        │
        ├── TerminalEmulator
        │     xterm.js 6.1 beta, kitty keyboard, fonts, themes, scrollback
        │
        ├── NasshRuntime adapter
        │     upstream CommandInstance.connectTo(), ssh and mosh paths
        │
        └── IWA adapter layer
              Chrome polyfills, Direct Sockets, asset URLs, web bundle constraints

Copied upstream assets
  nassh, wassh, wasi-js-bindings, OpenSSH/Mosh WASM plugin files
```

## Development

```bash
npm install
npm run dev
npm run dev:chrome
npm run fetch-assets
npm run typecheck
npm run build
```

IWA install on ChromeOS is documented in [docs/IWA_DEV_SETUP.md](docs/IWA_DEV_SETUP.md). Upstream asset handling is documented in [docs/UPSTREAM_SYNC.md](docs/UPSTREAM_SYNC.md) and [docs/UPSTREAM_NASSH_NOTES.md](docs/UPSTREAM_NASSH_NOTES.md).

Initialize upstream libapps when needed:

```bash
git submodule update --init --depth 1 upstream/libapps
```

## Verification

Final reset acceptance requires:

- `npm run typecheck`
- `npm run build`
- reset unit tests
- installed-IWA SSH smoke to a known working host
- installed-IWA Mosh smoke to a host with `mosh-server`
- live font/theme application
- kitty keyboard option propagation
- large-output and long-scrollback smoke

Device results should be recorded in [docs/TEST_PLAN.md](docs/TEST_PLAN.md).

## License

Upstream libapps is Chromium-licensed. xterm.js is MIT. Preserve upstream notices for copied runtime and plugin assets.
