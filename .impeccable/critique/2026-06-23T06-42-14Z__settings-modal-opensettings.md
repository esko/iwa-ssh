---
target: settings
total_score: 32
p0_count: 0
p1_count: 0
timestamp: 2026-06-23T06-42-14Z
slug: settings-modal-opensettings
---
# Settings Critique — Gosh

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Selected tab/profile/theme all clear; live theme preview; settings auto-apply silently (no explicit "saved") |
| 2 | Match System / Real World | 3 | "About" is actually a readiness/diagnostics panel; "nassh/wassh" jargon (audience is technical) |
| 3 | User Control and Freedom | 4 | ×, Escape, click-out all close; free tab/profile switching; auto-apply |
| 4 | Consistency and Standards | 3 | Set-rows + dark dropdowns are cohesive; but native window.prompt/confirm for profiles breaks the custom UI |
| 5 | Error Prevention | 3 | Selects constrain choices; font-URL add is guarded; delete uses native confirm |
| 6 | Recognition Rather Than Recall | 4 | Every control has an explaining hint; theme swatches preview live — exemplary |
| 7 | Flexibility and Efficiency | 3 | Settings profiles are a real power feature; but no arrow-key tab nav, rename only via right-click |
| 8 | Aesthetic and Minimalist | 3 | Genuinely clean; the eyebrow on every group (PROFILE/THEME/TEXT/…) is the one drag |
| 9 | Error Recovery | 3 | Font-add surfaces a message; few other error paths |
| 10 | Help and Documentation | 3 | The inline hints ARE the docs (great); but no app version anywhere |
| **Total** | | **32/40** | **Good — the most mature surface; native dialogs + a mislabeled About are the main gaps** |

## Anti-Patterns Verdict

**LLM assessment:** Does not read as AI-generated. The two-column settings (aside nav + tabbed main) is a familiar, trustworthy pattern executed cleanly; the theme swatches with live faux-terminal previews are a genuine craft highlight. The one tell is the **uppercase tracked eyebrow on every group** (PROFILE / THEME / TEXT / TEXT RENDERING / READINESS) — the same AI-grammar cadence already removed from the launcher.

**Deterministic scan:** `detect.mjs` on the markup is clean (0 findings).

**Visual evidence:** Inspected live across Appearance, Rendering, and About tabs, plus the profile aside. Findings are grounded in those.

## Overall Impression

The most polished surface in the app — consistent set-rows, dark dropdowns (now fixed), and inline hints that double as documentation. Two things keep it from excellent: profile create/rename/delete fall through to **native browser dialogs** (window.prompt/confirm), the same jarring break the file-input had; and the **"About" tab is a readiness panel that never shows the app version** or any actual "about" content. The single biggest win is replacing the native profile dialogs with an inline styled flow.

## What's Working

1. **Inline hints as documentation.** Every control explains itself ("Smooth uses gamma-corrected antialiasing…", "Falls back to the bundled Symbols Nerd Font…"). Recognition over recall, done right — a user never has to guess what a setting does.
2. **Theme swatches with live previews.** Each theme renders a tiny faux terminal in its own palette. You see exactly what you're choosing — far better than color chips.
3. **Consistent rhythm + on-brand controls.** Label-on-left / control-on-right set-rows separated by hairlines, the selected nav/profile carrying state by fill + ring, and dropdowns that now match the dark theme.

## Priority Issues

- **[P2] Profile create/rename/delete use native browser dialogs.** "New profile" and "Rename" fire `window.prompt`; deletes fire `window.confirm` — light OS dialogs that clash with the custom dark UI, exactly like the file-input did. Rename/delete are also only reachable by right-clicking a pill (zero visible affordance).
  - **Fix:** Inline the profile flow — an editable field (or a small styled prompt) for create/rename, a styled confirm for delete, and a visible affordance on each pill (hover actions or an inline edit).
  - **Suggested command:** /impeccable harden

- **[P2] "About" is a mislabeled diagnostics panel with no version.** The tab reads "About" but shows only a readiness checklist; the app version (currently 0.1.60) appears nowhere in the product. Users expect "About" to tell them what version they're on.
  - **Fix:** Either rename the tab to "Diagnostics"/"Status" and add a real About (version, brief identity, links), or fold both under About with the version up top.
  - **Suggested command:** /impeccable clarify

- **[P3] Eyebrow on every group.** PROFILE / THEME / TEXT / TEXT RENDERING / READINESS are the uppercase tracked kicker repeated per section — the AI cadence already retired on the launcher.
  - **Fix:** Quieter cadence (sentence-case group headers, or drop where the content is self-evident), consistent with the launcher pass.
  - **Suggested command:** /impeccable typeset

- **[P3] "Unavailable" readiness rows offer no remediation.** Direct Sockets / UDP / Mosh show "Unavailable" with no hint of why (IWA-only) or what to do, leaving a technical user guessing.
  - **Fix:** Add a one-line reason per unavailable row ("Requires the installed IWA on ChromeOS").
  - **Suggested command:** /impeccable clarify

- **[P3] Fixed-size modal on narrow viewports.** The 720×560 modal with a 200px aside + main column can cramp below ~600px wide; the two-column settings doesn't restructure.
  - **Fix:** Collapse the aside to a top tab-bar (or stack) below a breakpoint.
  - **Suggested command:** /impeccable adapt

## Persona Red Flags

**Alex (Power User):** Settings profiles are a great power feature, but tab navigation isn't arrow-key driven, and rename/delete hide behind right-click. The native prompt interrupts an otherwise fast flow.

**Sam (Accessibility):** Tabs carry `role="tab"`/`aria-selected` and status uses color + text (good). But the profile pills' only management path is right-click (no keyboard equivalent surfaced), and the native dialogs, while technically accessible, drop the user out of the styled context.

**Jordan (First-Timer):** The inline hints make most settings approachable. But opening "About" and finding "Direct Sockets: Unavailable / nassh-wassh assets" with no explanation is confusing for a newcomer.

## Minor Observations

- The selected "default" profile pill reads a little like a text input (bordered box); a subtle affordance ambiguity.
- Settings auto-apply with no explicit confirmation — modern and fine, but a brief "Saved" or live-preview cue reassures on the less-visible tabs (Keyboard/Behavior).

## Questions to Consider

- Should profile management move fully inline (create/rename/delete) so the app never drops to a native dialog?
- Is "About" the right name for a readiness panel — or should About show the version and identity, with diagnostics as their own thing?
- The per-group eyebrows: keep as a deliberate settings system, or retire them to match the launcher's quieter cadence?
