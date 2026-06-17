# Domain Docs

This is a single-context repo. Before changing product direction, frontend architecture, runtime transport, or issue planning, read:

- `docs/LEGACY_PWA_PIVOT_PRD.md`
- `docs/LEGACY_PWA_PIVOT_PLAN.md`
- `docs/RESET_PRD.md`
- `docs/ARCHITECTURE.md`
- `docs/UPSTREAM_SYNC.md`
- `docs/references/chromeos-terminal/README.md` (design/functionality north star)
- relevant ADRs in `docs/adr/`

## Vocabulary

- **legacy PWA frontend**: Moshtty `legacy-pwa:web/`, used as the frontend base.
- **profile**: `iwa-ssh` saved connection model. Profiles replace legacy PWA workspaces/spaces/sessions as the launch model.
- **native app tab**: ChromeOS/IWA tab. One terminal connection lives in one native tab.
- **transport boundary**: small adapter between Ghostty terminal I/O and browser networking, with echo and Direct Sockets SSH implementations.
- **IWA infrastructure**: Vite/IWA packaging, manifests, signing/bundling scripts, Direct Sockets permissions, install docs, upstream nassh/wassh assets, and thin polyfills/adapters.

Flag contradictions with the legacy-PWA pivot explicitly instead of silently reviving old xterm/app-shell UI work.
