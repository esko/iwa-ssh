# Domain Docs

This is a single-context repo.

## Before exploring

Read `CONTEXT.md` if it exists and the relevant ADRs under `docs/adr/`. Proceed silently if `CONTEXT.md` is absent; domain-modeling skills create it lazily when useful.

Before changing product direction, frontend architecture, runtime transport, or issue planning, also read:

- `docs/LEGACY_PWA_PIVOT_PRD.md`
- `docs/LEGACY_PWA_PIVOT_PLAN.md`
- `docs/RESET_PRD.md`
- `docs/ARCHITECTURE.md`
- `docs/UPSTREAM_SYNC.md`
- `docs/references/chromeos-terminal/README.md` (design/functionality north star)
- Relevant ADRs in `docs/adr/`

## Vocabulary

- **legacy PWA frontend**: Moshtty `legacy-pwa:web/`, used as the frontend base.
- **profile**: `iwa-ssh` saved connection model, replacing legacy PWA workspaces, spaces, and sessions.
- **tab**: An app-rendered tab in the custom unframed caption.
- **pane session**: A Restty pane with its own connection intent, transport, and optional ET resume identity.
- **transport boundary**: A narrow `TerminalSink` between pane I/O and browser networking.
- **IWA infrastructure**: Vite/IWA packaging, manifests, signing/bundling scripts, Direct Sockets permissions, install docs, upstream nassh/wassh assets, and thin polyfills/adapters.

Use terms defined in `CONTEXT.md` when it exists. Flag contradictions with existing ADRs or the legacy-PWA pivot explicitly instead of silently overriding them.
