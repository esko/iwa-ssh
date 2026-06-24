---
target: main + new tab screen + launcher modifications
total_score: 31
p0_count: 0
p1_count: 0
timestamp: 2026-06-24T14-43-05Z
slug: app-src-pwa-views-ts-launcher-new-tab-host-picker
---
## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Launcher tab has no status of its own; the muted "New Tab" title reads as a label, not an interactive pending state. |
| 2 | Match System / Real World | 3 | "Connect" vs "Connect & Save" maps to throwaway-vs-persistent, but the phrasing is developer-speak. |
| 3 | User Control and Freedom | 3 | Esc closes the ⌘K overlay and clears the filter; launcher tab closes via ×. No in-row "save this recent as a host". |
| 4 | Consistency and Standards | 3 | `.filter-kbd` `/` hint renders in `var(--mono)` (styles.css:235) — debatable for a keycap, but the only mono in chrome. |
| 5 | Error Prevention | 3 | The address bar silently switches between filter and quick-connect on Enter with no visible mode signal. |
| 6 | Recognition Rather Than Recall | 3 | ⌘K is undiscoverable — no visible hint; only the `/` filter cue is shown. |
| 7 | Flexibility and Efficiency | 4 | Genuinely strong: `/`, ⌘K, Enter-to-launch, `ssh user@host` quick-connect, fuzzy rank, arrow-key nav, in-place tab upgrade. |
| 8 | Aesthetic and Minimalist Design | 3 | Disciplined monochrome execution; the one tension is three overlapping "find & launch" paths on one screen. |
| 9 | Error Recovery | 3 | Connect failures surface a message; but `renderHostPicker`/`renderHome` async loads have no catch → blank picker if IndexedDB fails. |
| 10 | Help and Documentation | 3 | Empty states teach well ("Type ssh user@host to connect"); no explanation of ⌘K or Connect-vs-Save for first-timers. |
| **Total** | | **31/40** | **Good — solid foundation, address the weak areas** |

## Anti-Patterns Verdict

**Does this look AI-generated? No.** It passes the product-slop test: a Raycast/Linear/Termius user would trust it on sight. No gradient text, no glassmorphism-as-default, no side-stripe borders, no eyebrow-on-every-section, no identical card grid. The monochrome cool-gray discipline holds and the picker reuses existing `.palette-*` tokens rather than inventing a parallel vocabulary (`.hostpick` uses `display:contents`; `.hostpick-row` stacks onto `.palette-row`).

The honest critique is **information architecture, not surface**: there are three overlapping entry points for the same verb (row click, the address bar, and the ⌘K picker), and the new-host modal presents Connect and Connect & Save as two sibling buttons. The execution is clean; a couple of IA choices were made by enumerating options rather than deciding which should dominate.

**Deterministic scan:** `detect.mjs` on `views.ts` → exit 0, zero findings (the UI is generated from `.ts` template literals, opaque to the static analyzer). On `styles.css` → 12 findings, **all false positives**: 5 are the user-selectable terminal monospace font stack (IBM Plex/Geist/Red Hat/DM Mono — terminal content, not chrome), 6 are semantic status colors (ET-cyan pill border, danger-red button, amber host-key warning, error status), 1 is a 4px radius on a debug-only element. No real CSS slop.

**Contrast (recomputed):** all text passes WCAG AA. `.hostpick-sub` (muted `#9aa0ab` on surface `#1f2127`) = **6.12:1**; `.palette-group` (faint `#868c97`) = **4.76:1**; muted "New Tab" tab title ≈ 7.8:1. (An earlier reviewer claim of ~4.0:1 on `.hostpick-sub` was incorrect.)

**Visual overlays:** no in-page detector overlay was injected (the Vite `.ts` SPA makes the inject-detect.js path unreliable); the CLI detector plus direct source inspection and prior in-session screenshots were used instead.

## Overall Impression

A confident, restrained launcher that earns the "Quiet Cockpit" north star. The standalone picker (new-tab / no-spec) lands the Termius reference cleanly, and the launcher-tab in-place upgrade is the standout idea. The single biggest opportunity is to **resolve the redundancy between the address bar and the ⌘K picker** and to **clarify the Connect vs Connect & Save hierarchy** — both are IA decisions, not visual fixes.

## What's Working

1. **Launcher-tab in-place upgrade** — "+" opens an unconnected "New Tab" hosting the picker; choosing a host silently upgrades that same tab to a live terminal, preserving strip position. No extra modal, no separate connecting screen. Architecturally and visually clean.
2. **Complete picker keyboard model** — arrow keys move, Enter confirms, Esc closes, pointermove syncs selection so mouse/keyboard don't fight, and a typed `ssh user@host` that matches nothing becomes an inline "Connect to user@host" row. Raycast-grade.
3. **Disciplined reuse** — the picker is built on the existing palette tokens via `display:contents` + class-stacking, not a fork. Confirmed: no duplicated component vocabulary.

## Priority Issues

**[P2] Address-bar dual behavior is invisible** — On the home filter, Enter either launches the top filtered match OR quick-connects if the text parses as `ssh user@host`. The mode switch lives only in code; a user typing `user@prod` to filter could be thrown into a connection attempt. *Fix:* when the value parses as a connectable target, surface it — e.g. swap the `/` kbd hint for `↵ connect`, or show an inline "Connect to user@host →" row beneath the field. *Command:* `/impeccable clarify`.

**[P2] Connect vs Connect & Save share visual weight** — In the new-host modal, Cancel and Connect are both `.btn-ghost`; only Connect & Save is primary. Scanning left-to-right reads {Cancel, Connect} as a pair, so the throwaway action competes with dismissal. *Fix:* reorder to `Cancel | Connect & Save (primary) | Connect`, or make Connect a quieter "connect without saving" text link beneath the row. *Command:* `/impeccable layout`.

**[P2] No error boundary on async picker/home loads** — `renderHostPicker` and `renderHome` `await listProfiles()` with no catch; an IndexedDB failure (possible on IWA first-install / quota) renders a silently blank picker with no recovery. *Fix:* try/catch → a `palette-empty` message + reload affordance. *Command:* `/impeccable harden`.

**[P3] Weak/again missing focus indicators** — `.palette-input` sets `outline:none` with no `:focus-visible` restore, and `.filter-input:focus` signals only via a low-alpha border bump. Picker rows highlight via JS (`pointermove`→`aria-selected`), so hover is covered, but the text inputs lack a clear ring. *Fix:* add a `:focus-visible` ring to both inputs. *Command:* `/impeccable audit`.

**[P3] No reduced-motion support (pre-existing, app-wide)** — There is no `@media (prefers-reduced-motion: reduce)` anywhere; `.conn-row`, chevron, `.session-row`, and status transitions all animate unconditionally. Not introduced by this change, but the new surfaces inherit it. *Fix:* one global reduced-motion block. *Command:* `/impeccable audit`.

## Persona Red Flags

**Alex (power user):** The address bar and ⌘K are two articulations of the same "find & launch" verb on one screen — Alex will pick ⌘K and read the address bar as noise. Strong accelerators otherwise (Enter-to-launch, quick-connect, arrow nav).

**Jordan (first-timer):** Lands on the new-host modal and meets Connect vs Connect & Save with no context for why saving matters; the eye hits the shorter "Connect" first and may create a throwaway that vanishes from the launcher, causing disorientation. ⌘K is invisible to Jordan.

**Sam (a11y/keyboard):** Contrast passes throughout (recomputed). Real gaps: the dynamic picker list has `role="listbox"`/`option` but no `aria-live`, so filter-as-you-type results aren't announced; the home "No hosts match" empty line has no `role="status"`; and the search inputs lack a visible focus ring.

## Minor Observations

- `connectEntry` tags the typed throwaway row `group: 'Saved hosts'` — harmless (the header is dropped while filtering) but a semantic smell; label it neutrally.
- `deleteProfileConfirmed` / `forgetSession` use `window.confirm()` (native OS dialog) — jarring against the styled surface; the codebase has a styled confirm pattern to migrate to.
- `.filter-kbd` `/` keycap uses `var(--mono)` — debatable (keycaps are conventionally mono) but it's the lone monospace in chrome per DESIGN.md's Mono-Stays-Inside rule.
- Edge case: a lone launcher tab hides the tab strip at `data-count='1'`, so its × close isn't shown; the picker becomes the only escape.

## Questions to Consider

1. Are the always-visible address bar and the ⌘K picker the same feature twice? Would ⌘K-only (with a visible discovery hint) remove the dual-mode-Enter problem entirely?
2. Should the throwaway "Connect" live only in the address bar/picker, where typed `ssh user@host` already implies a one-off — keeping the saved-host form single-actioned?
3. What's the intended back-path from a lone launcher tab when the strip is hidden?
