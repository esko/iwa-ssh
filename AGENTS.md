# Agent Guide

This repo has pivoted from a near-upstream Google Terminal UI reset to a Moshtty `legacy-pwa` frontend replacement. The frontend base is the legacy PWA/Ghostty shape; `iwa-ssh` keeps IWA packaging, manifests, signing/bundling scripts, Direct Sockets permissions, install docs, upstream nassh/wassh runtime assets, and thin platform adapters.

## Current Product Direction

- Base frontend work on Moshtty `legacy-pwa`, pruned for IWA.
- Use Ghostty-web for the terminal renderer and terminal canvas/layout behavior.
- One terminal session per window (interim): `/` (index.html) is the home/launcher and launching opens `/terminal.html` in its own window. Native ChromeOS app tabs are unavailable for IWAs for now and are deferred — keep the multi-page structure and manifest `tab_strip`/`display_override` config for re-enabling later. See `docs/adr/0007-one-session-per-window.md` and #45.
- Use `iwa-ssh` profiles as the launcher/session model, replacing legacy PWA workspaces, spaces, internal tabs, panes, splits, and durable Go-agent sessions.
- Plug IWA Direct Sockets SSH transport into the frontend through a small transport boundary.
- Match the ChromeOS Terminal design/functionality north star in `docs/references/chromeos-terminal/` (profile-first launcher home, native tabs, tabbed Appearance/Keyboard/Behavior settings).

Do not reuse old `iwa-ssh` app-shell routes, xterm terminal UI, upstream Terminal-shaped settings screens, session route UI, simulated tabs, dashboard, or debug-first frontend surfaces. Keep code under `app/src/ssh`, `app/upstream`, IWA manifests, and scripts only when it is low-level IWA/runtime infrastructure.

Mosh remains a follow-up transport after SSH over Direct Sockets is stable. Do not keep old nassh UI scaffolding just to preserve Mosh.

## Implementation Rules

- Read `docs/LEGACY_PWA_PIVOT_PRD.md`, `docs/LEGACY_PWA_PIVOT_PLAN.md`, `docs/RESET_PRD.md`, `docs/ARCHITECTURE.md`, `docs/UPSTREAM_SYNC.md`, and the relevant ADR before changing reset work.
- Keep upstream-copied runtime files mechanically refreshed by `scripts/fetch-upstream-assets.mjs`; document local patches there or in `docs/UPSTREAM_SYNC.md`.
- Put IWA/Direct Sockets adaptations in thin adapter, transport, or polyfill modules. Do not push app-specific concerns into Ghostty renderer modules.
- Every change to the installed IWA—including app code, runtime assets, manifests, packaging, or behavior—must bump the IWA version in the same change. Run `npm run bump-version` and verify `package.json`, `package-lock.json`, and both web manifests all report the new version before handing off.
- Check `git status --short` before edits and do not overwrite unrelated local changes.
- Use separate git worktrees for parallel implementation slices or subagent-owned coding work. Name worktrees after the issue or slice, keep each worktree scoped to one reset issue when possible, and merge results back only after review and verification.
- Verify with the smallest relevant command first, then run broader checks before handing off.

## Cost And Parallelism

Use cheap subagents when they can reduce cost or safely parallelize work, even if the main agent could do the task directly. Good subagent tasks include independent doc review, upstream/source comparison, test inventory, UI route inventory, and narrow code audits. Keep implementation decisions, final edits, and verification orchestration in the main agent unless the task is explicitly delegated.

Do not spawn subagents for tiny single-file edits or when their context loading would cost more than the work. When using subagents, give bounded instructions, ask for file/line evidence, and merge only reviewed output.

## Agent skills

### Issue tracker

Issues and PRDs live in GitHub Issues for `esko/iwa-ssh`; external PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical GitHub labels, including `ready-for-agent` for AFK-ready work. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo with root domain docs and ADRs under `docs/adr/`. See `docs/agents/domain.md`.
