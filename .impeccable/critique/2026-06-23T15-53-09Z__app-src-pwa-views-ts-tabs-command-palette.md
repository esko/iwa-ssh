---
target: tabs and command palette
total_score: 33
p0_count: 0
p1_count: 0
timestamp: 2026-06-23T15-53-09Z
slug: app-src-pwa-views-ts-tabs-command-palette
---
# Critique: terminal tabs + command palette

Scope: the custom caption tab strip (`.term-tab`) and the Ctrl+Shift+P command palette (`.palette`) in `app/src/pwa/views.ts` + `app/src/pwa/styles.css`. Evaluated live on the echo test-intent across the default pure-black theme, Tokyo Night, and Light.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Active-tab affordance is fill-only and ~1.3:1 against the bar on the pure-black default |
| 2 | Match System / Real World | 4 | Standard "Command palette / New tab / Split right", correct ⌃⇧ glyphs |
| 3 | User Control and Freedom | 4 | Esc + backdrop close; disabled-row gating; confirm-on-close |
| 4 | Consistency and Standards | 3 | Palette flattens the context-menu's family separators; filter is substring not subsequence |
| 5 | Error Prevention | 4 | Disabled rows can't run; Enter on empty no-ops; confirmClose |
| 6 | Recognition Rather Than Recall | 3 | Great action surfacing, but no ↑↓/Enter/Esc legend; new-tab chevron menu is hidden |
| 7 | Flexibility and Efficiency | 4 | Keyboard-first palette + shortcut hints + dynamic tab-switch entries |
| 8 | Aesthetic and Minimalist | 3 | On-brand and clean; flat 18-row list and low-contrast key hints are the soft spots |
| 9 | Error Recovery | 3 | n/a — these surfaces don't raise errors (transport errors go to the status pill) |
| 10 | Help and Documentation | 2 | No inline legend in the palette; no tooltip on the new-tab chevron |
| **Total** | | **33/40** | **Good** |

## Anti-Patterns Verdict

**LLM assessment:** Does not read as AI slop. It passes the product slop test — a Raycast/VSCode-fluent user would trust it. The palette is a top-anchored spotlight bar reusing the shared overlay (Esc/backdrop/stacking), and the tabs now blend into the terminal palette instead of a black band. No absolute-ban violations: no side-stripe borders, no gradient text, no glass, no hero-metric. The 8px rounded-rect tabs and quiet selection highlight are restrained and on-brand ("chrome whispers").

**Deterministic scan:** `detect.mjs` over `views.ts`, `index.html`, `terminal.html` returned `[]` (clean). The palette/tab markup lives in TS template strings, so the CLI detector has limited reach there; browser inspection carried the visual evidence.

**Visual/measured evidence (default #000 theme):** active tab fill resolves to ~#212121 (color-mix +13%), giving ~1.3:1 separation from the black bar. Palette key-hint glyphs are `--faint` #868c97; on the selected row (12% white over surface) that lands ~3:1 — below WCAG AA for ~11px text. Palette label text is high-contrast (~13:1). Light theme mirrors the same subtle active-tab separation (~1.29:1).

## Overall Impression

Two genuinely good, keyboard-first surfaces that respect the brand's "the terminal is the product" stance. The palette is the strongest addition — it turns the whole context menu into one searchable, gated list. The biggest opportunity is **state legibility under restraint**: the active tab and the palette's key hints both whisper a little too quietly to read cleanly at the contrast extremes (pure black, pure white).

## What's Working

1. **Palette gating + dynamic entries.** Disabled rows (Close pane with one pane, Next/Previous tab with one tab) are computed at open time and skipped by arrow-nav, and per-open "Switch to tab: …" rows are generated. That's earned-familiarity power-user behavior.
2. **Palette reuses the overlay system.** Esc-topmost, backdrop-dismiss, and z-stacking come for free and match every other modal — strong Consistency.
3. **Tabs tint to the terminal palette.** Bar, active pill, and text all derive from `--term-bg`/`--term-fg`, so the strip belongs to the terminal it sits above across themes.

## Priority Issues

- **[P2] Active-tab state is fill-only and faint at the contrast extremes.** Active and inactive tabs share the same label color (inactive just drops to 68% alpha) and the active fill is only ~1.3:1 from the bar on the default black theme (and on white). Which tab is active relies on a whisper.
  - **Why it matters:** "Which session am I in" is core to the product's one-clear-session-model principle. On the default theme that signal is the weakest.
  - **Fix:** Keep it quiet but add a second cue — `font-weight: 500` on the active label, and/or lift the active fill to ~16–18% on dark / sink ~13–15% on light, or a 1px inset ring using `--term-fg` at low alpha.
  - **Suggested command:** `/impeccable polish`

- **[P2] Palette key-hint contrast below AA.** The `⌃⇧E`-style hints use `--faint` (#868c97), ~3:1 on rows and on the selected row. At ~11px that fails AA (4.5:1).
  - **Why it matters:** The shortcut hints are the palette's teaching surface — they migrate users from palette to muscle memory. If they're hard to read they don't teach.
  - **Fix:** Bump hint color toward `--muted` (#9aa0ab) or brighten on the selected row specifically; verify ≥4.5:1 on both the row and selected-row backgrounds.
  - **Suggested command:** `/impeccable audit`

- **[P2] Palette filter is substring, not subsequence.** `label.toLowerCase().includes(needle)` means "cppath" or "spltdwn" match nothing; only contiguous substrings work. Category leaders (Raycast, VSCode, Linear) all do subsequence/fuzzy.
  - **Why it matters:** Power users type abbreviated, non-contiguous queries by reflex; a miss feels broken.
  - **Fix:** Swap `includes` for a subsequence match (optionally rank by match position/contiguity).
  - **Suggested command:** `/impeccable harden`

- **[P2] Palette isn't a proper combobox for screen readers.** The `<input>` and `role="listbox"` are siblings with no `aria-controls`/`aria-activedescendant`, so arrowing the list never announces the active option to AT; `aria-expanded` is also absent.
  - **Why it matters:** Sam (keyboard/AT) can open and type but gets no feedback on which command is selected.
  - **Fix:** Wire the input as a combobox: `role="combobox"`, `aria-expanded`, `aria-controls` → list id, and set `aria-activedescendant` to the selected row's id on each move.
  - **Suggested command:** `/impeccable audit`

- **[P3] Palette is a flat 18-row list; the context menu's family separators are lost.** The right-click menu groups clipboard / split / session / settings with separators; the palette dropped them into one stream.
  - **Why it matters:** With 18 rows the un-filtered scan is longer than it needs to be; light grouping speeds recognition.
  - **Fix:** Reintroduce non-selectable group headers or thin separators between families (Tabs · Panes · Clipboard · Session · App).
  - **Suggested command:** `/impeccable layout`

## Persona Red Flags

**Alex (Power User):** Mostly satisfied — Ctrl+Shift+P, shortcut hints, disabled gating, dynamic tab switch. Two reflex-breakers: (1) substring-only filter rejects his abbreviated queries; (2) no most-recent/most-used ordering, so the same two commands never float up.

**Sam (Accessibility):** Can open and drive the palette by keyboard, but the missing `aria-activedescendant` means his screen reader never announces the highlighted command as he arrows. Key hints at ~3:1 and the active-tab fill at ~1.3:1 fall below the contrast he needs. Disabled rows are conveyed by opacity (color/opacity-only state).

**Riley (Stress Tester):** Held up well in testing — empty-filter shows "No matching commands." and Enter no-ops; disabled-skip nav wraps correctly; Escape closes topmost only. No broken states found.

## Minor Observations

- No `↑↓ Enter Esc` legend in the palette footer; discoverable by reflex but a quiet legend would help first-timers.
- The new-tab `+` and the adjacent chevron (open-from-profile menu) are two controls with no tooltip; the chevron's purpose is invisible until clicked.
- Close `×` shows on every tab at all times; fine at 2 tabs, potentially noisy at 8+ (consider hover/active-only for inactive tabs).
- Palette row vertical padding (9px) is slightly loose for a dense power tool; tightening would show more rows per viewport.

## Questions to Consider

- What would the active tab look like if state legibility were a requirement, not a whisper — can it stay on-brand with a weight change alone?
- Should the palette learn (recent/frequent on top), or is a stable, memorizable order more valuable for muscle memory here?
- If the key hints are the teaching surface, should they be the *most* legible quiet element rather than the least?
