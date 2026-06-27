---
name: Gosh
description: A soft-dark, monochrome IWA terminal client where the chrome recedes and the terminal is the only loud surface.
colors:
  bg: "#16171b"
  surface: "#1f2127"
  surface-2: "#292c34"
  fg: "#e7e9ee"
  muted: "#9aa0ab"
  faint: "#868c97"
  line: "#ffffff12"
  line-2: "#ffffff1f"
  term-bg: "#000000"
  status-connecting: "#e0b341"
  status-error: "#e0574b"
  accent-et: "#9adfff"
  accent-mosh: "#a5f3b1"
  primary-btn-top: "#363a43"
  primary-btn-bottom: "#2b2e36"
typography:
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  control:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "0.1em"
  mono:
    fontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, monospace"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
rounded:
  xs: "6px"
  sm: "8px"
  md: "12px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "36px"
components:
  button-ghost:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.fg}"
    rounded: "{rounded.sm}"
    padding: "9px 18px"
    typography: "{typography.control}"
  button-primary:
    backgroundColor: "{colors.primary-btn-top}"
    textColor: "{colors.fg}"
    rounded: "{rounded.sm}"
    padding: "9px 18px"
    typography: "{typography.control}"
  input-field:
    backgroundColor: "#00000038"
    textColor: "{colors.fg}"
    rounded: "{rounded.sm}"
    padding: "9px 11px"
    typography: "{typography.control}"
  conn-row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    rounded: "{rounded.sm}"
    padding: "13px 14px"
    typography: "{typography.body}"
  modal:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    rounded: "{rounded.md}"
    padding: "30px"
  conn-pill:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted}"
    rounded: "{rounded.pill}"
    padding: "2px 7px"
    typography: "{typography.label}"
---

# Design System: Gosh

## 1. Overview

**Creative North Star: "The Quiet Cockpit"**

Gosh is a dark instrument panel built to recede. The terminal is the only surface that earns brightness; every launcher row, dialog, tab, and settings control around it is a calm, low-contrast control that exists to get the user connected and then disappear. The system is monochrome by conviction — a single cool-gray ramp from near-black to off-white carries 95% of the interface, and the eye is never pulled away from the working surface unless something needs a decision. This is a tool that expresses power through restraint, not through density of controls or ornament.

Surfaces are soft, not sharp: gently-gradiented panels, 12px corner radii, hairline white-on-black dividers, and shadows that appear only when an element genuinely floats above the black desktop. Color enters the system in exactly three places and nowhere else — transport-type pills (ET cyan, Mosh green), connection status dots (amber connecting, red error), and the one light primary button. Restraint is the whole personality.

This system explicitly rejects the **iTerm2 / heavy-configurator** aesthetic: no tabs-on-tabs, no floating tool panels, no preference dialogs that rival the terminal in visual weight, no configurability-as-identity. The settings surface is a quiet two-column list, not a control room. If the chrome ever competes with the terminal for attention, the design has failed.

**Key Characteristics:**
- Monochrome cool-gray ramp; color reserved for status and transport identity only.
- Dark by default (`color-scheme: dark`); the terminal canvas is true black.
- Soft surfaces: 8–12px radii, subtle vertical gradients, hairline `rgba(255,255,255,…)` borders.
- Depth on demand: flat in-flow, shadowed only when floating.
- Inter for all chrome; monospace lives strictly inside the terminal.

## 2. Colors

A single cool-gray ramp from near-black to soft white, with color admitted only for status and transport identity.

### Primary
The system has no traditional brand "primary" color. Its primary expression is the **near-black canvas + soft-white ink** pairing; identity is carried by the absence of color, not its presence.
- **Pit Black** (`#16171b`): the app body background, served under a faint radial gradient (`radial-gradient(125% 90% at 50% -15%, #20222a 0%, #16171b 58%)`) so the top-center lifts almost imperceptibly. The terminal canvas itself goes fully black (`#000000`).
- **Soft White** (`#e7e9ee`): primary text ink. Never pure white in chrome — pure white is reserved for the terminal's high-contrast foreground.

### Secondary — Transport & Status accents
The only saturated colors in the system. Each maps to a specific, scannable meaning.
- **ET Cyan** (`#9adfff`): Eternal Terminal transport pill only.
- **Mosh Green** (`#a5f3b1`): Mosh transport pill only.
- **Connecting Amber** (`#e0b341`): the leading status dot while a tab is connecting or disconnecting.
- **Error Red** (`#e0574b`): error status dot; softened to `#f0c5c5` for error text in the status pill and `#e9a0a0` for failed diagnostics rows.

### Neutral
The working ramp. Every surface and every piece of text is one of these.
- **Surface** (`#1f2127`) / **Surface-2** (`#292c34`): raised panels — modals, context menus, the status pill — and selected/hover states. Surface carries a subtle gradient (`linear-gradient(180deg, #24262d 0%, #1d1f24 100%)`).
- **Muted** (`#9aa0ab`): secondary text — metadata, control labels, inactive nav items.
- **Faint** (`#868c97`): the quietest *legible* text — meta, hints, eyebrow labels, placeholders. Tuned to ~5.3:1 on the body so it still passes WCAG AA; never drop tertiary text below this. Purely decorative glyphs (the row chevron, the `/` hint) may sit lower.
- **Line** (`rgba(255,255,255,0.07)`) / **Line-2** (`rgba(255,255,255,0.12)`): hairline dividers and borders. Borders are always white-at-low-alpha over the dark surface, never a gray fill.

### Named Rules
**The Color-Means-Status Rule.** Saturated color is forbidden as decoration. Cyan, green, amber, and red appear *only* to communicate transport type or connection state. If a color is on screen and it isn't telling the user something about a connection, it's a bug.

**The No-Pure-White-In-Chrome Rule.** Pure `#ffffff` belongs to the terminal foreground. Chrome ink tops out at Soft White (`#e7e9ee`) so the terminal always reads as the brightest, sharpest surface in the window.

## 3. Typography

**UI Font:** Inter (with `ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto` fallback)
**Terminal Font:** JetBrains Mono, default of a bundled set (IBM Plex Mono, Geist Mono, Red Hat Mono, DM Mono), plus arbitrary user families incl. Nerd Fonts.

**Character:** One humanist sans for every piece of chrome, one monospace for every character inside the terminal — a hard, legible boundary between "the app talking" and "the machine talking." The pairing is functional, not decorative: there is no display face, no serif, no second sans. Hierarchy is built entirely from weight, size, and the cool-gray ink ramp.

### Hierarchy
- **Title** (600, 16px, -0.01em): modal and settings headings (`.modal h2`, `.aside-title`). The largest type in the system — there is deliberately no hero/display tier.
- **Body** (400, 14px, 1.5): the base size. Connection targets, settings rows, prompts.
- **Control** (400–550, 13px): buttons, inputs, tabs, nav items, context-menu items. The dominant size of the interface.
- **Meta** (400, 12–12.5px, Faint/Muted): connection metadata, hints, status pill text.
- **Label** (600, 11px, 0.1em, UPPERCASE, Faint): section eyebrows (`.section-label`, `.group-title`, `.aside-label`). Used to title grouped settings regions.

### Named Rules
**The Mono-Stays-Inside Rule.** Monospace is forbidden in chrome. JetBrains Mono and its siblings render *only* terminal content (and the tiny theme-preview chips that simulate terminal output). UI labels, buttons, and settings are always Inter. The font itself signals which world you're looking at.

**The Flat-Hierarchy Rule.** No display type. The biggest text on any screen is a 16px title. Importance is communicated by weight and ink lightness, never by scale — because the loudest thing on screen must always be the terminal.

## 4. Elevation

Depth is **lifted on demand**: surfaces in the normal flow (launcher rows, settings panels, tab strip) are flat — separated only by hairline borders and a one-step lightness change. Shadow and gradient appear exclusively on elements that genuinely float above the black desktop: modals, context menus, and the transient status pill. There is no ambient elevation; nothing casts a shadow at rest.

### Shadow Vocabulary
- **Floating** (`box-shadow: 0 20px 60px -18px rgba(0,0,0,0.75), 0 2px 8px -2px rgba(0,0,0,0.5)`): the single elevation token (`--shadow`). Used on modals, context menus, and the status pill. A long, soft, downward cast that reads against pure black — a tight blur would look like a 2014 app.
- **Inset highlight** (`inset 0 1px 0 rgba(255,255,255,0.5)` on the primary button; `inset 0 0 0 1px var(--line-2)` on selected nav/profile pills): a 1px top light line or full inset ring that marks a raised or selected control without a drop shadow.
- **Backdrop blur** (`backdrop-filter: blur(6px) saturate(120%)`): reserved for the modal overlay scrim only — not a decorative glass treatment.

### Named Rules
**The Lift-On-Demand Rule.** Surfaces are flat at rest. A shadow is a statement that an element is floating above everything else — so only overlays (modal, context menu, status pill) get one. An in-flow card with a drop shadow is forbidden.

## 5. Components

### Buttons
- **Shape:** softly rounded (`8px`, `--radius-sm`).
- **Primary (raised dark):** the affirmative action (Connect, Save). A dark gradient a step lighter than the surface (`linear-gradient(180deg, #363a43, #2b2e36)`), Soft-White text at 600 weight, a crisp bright hairline (`rgba(255,255,255,0.26)`), and a top inset highlight (`inset 0 1px 0 rgba(255,255,255,0.1)`). On hover the hairline brightens to `0.42` and the fill lifts via `brightness(1.1)`; presses down 1px on `:active`. It reads as *the* action without becoming the brightest thing on a dark screen.
- **Ghost (secondary):** genuinely quiet — a faint wash (`rgba(255,255,255,0.04)`), dim hairline (`--line`), Muted text. On hover the wash and border lift one step and the text brightens to Soft White. Recedes next to the primary (Cancel, inline utility actions).
- **Hover / Focus:** buttons transition border, fill, and brightness on a 0.12s ease; focus-visible draws a 2px `--focus` ring (`rgba(140,170,210,0.7)`) at 2px offset.
- **Icon buttons** (`.icon-btn`): 34px square, transparent until hover, then Surface fill + brighter border; the standard affordance for inline row actions (edit/delete) and the launcher header.

### Named Rules
**The No-Light-Slab Rule.** The Quiet Cockpit has no near-white button. The primary action earns emphasis through a *raised dark* surface — lighter fill, brighter hairline, inset highlight, heavier weight — never by inverting to a light fill. A white button would out-shine the terminal, which is forbidden.

### Launcher (signature surface)
A single **centered column** (`min(560px, 100%)`), not a multi-column dashboard — symmetric framing instead of a top-left float. The scroll container is full-width so the scrollbar sits at the viewport edge (never mid-page beside the column), and scrollbars everywhere are thinned to a rounded Line-2 thumb on a transparent track. Brand lockup at top; a footer (`margin-top: auto`) pins Settings + a quiet SSH-keys disclosure to the bottom so the page reads composed top-to-bottom. Once the saved list reaches ~4, a **search / quick-launch** field appears (leading magnifier, a `/` `<kbd>` hint that focuses it from anywhere, Enter launches the top match). The **first-run empty state** is the activation moment, not a void: a "Connect to your first server" headline, one line naming the transports, a raised-dark primary CTA, and a right-click hint.

### Connection rows (signature component)
The launcher's core element. A full-width flush row (`13px 14px`, transparent at rest) that fills with Surface and a hairline border on hover. A `›` chevron fades and slides in from the right on hover; rows carrying inline edit/delete actions suppress the chevron and reveal the action buttons instead. A leading transport **pill** (`.conn-pill`, 999px radius, 10px/700 uppercase) tags ET/Mosh in their accent colors; the row body is a tight two-line stack of target (14px/500) and meta (12px Faint).

### Inputs / Fields
- **Style:** translucent black fill (`rgba(0,0,0,0.22)`), Line-2 border, 8px radius, 13px text. Labels sit above as 12px Muted spans.
- **Focus:** border brightens to `rgba(255,255,255,0.32)` and the fill deepens to `rgba(0,0,0,0.32)` — no glow, no color shift.
- **Placeholder:** Faint (`#868c97`).
- **Select caret:** native arrow suppressed (`appearance: none`); a Muted chevron is drawn at a fixed `right 11px center` so placement is consistent across every OS, with `padding-right` reserving its space.

### Modals & overlays
Centered dialogs (`min(440px)`, 12px radius, 30px padding) on a blurred 66%-black scrim, carrying the Floating shadow and Surface gradient. Wide variant (`720×560`) hosts the settings two-column layout. Z-index scale is semantic and low: overlay `50`, context menu `80`, debug panel `1200`, titlebar `2000`.

### Tabs (custom caption)
ChromeOS-style in-window tabs hosted in the unframed window's caption. 30–36px tall, 8px top-rounded, transparent until active (then Surface fill). A leading status dot encodes connection state (hidden when connected, amber connecting, red error); an optional pane-count badge and a circular close button sit inline. The tab strip hides itself at `data-count='1'` — chrome stays quiet until there's a real choice to make. The "+ ⌄" new-tab control is a lighter segmented pill (`rgba(255,255,255,0.09)`) with a hairline divider between the add and menu halves.

### Settings
A flat two-column layout: a 200px aside (nav list + profile pills, faint-black tint) and a tabbed main panel. Nav items are 13px, Muted at rest, Surface-2 + inset ring when selected (no accent ledge — the fill and ring carry the state). Setting rows are flush, separated by Line top-borders, label-on-left / control-on-right (`220px` control column). No cards.

## 6. Do's and Don'ts

### Do:
- **Do** keep saturated color tied to meaning — ET cyan, Mosh green, amber/red status, and nothing else.
- **Do** cap chrome ink at Soft White (`#e7e9ee`); reserve pure white for the terminal foreground.
- **Do** keep every *text* role at WCAG AA (≥4.5:1) — Faint is the floor at ~5.3:1. Drop below it only for purely decorative glyphs (chevron, kbd hint), never for words a user reads.
- **Do** keep surfaces flat in-flow and add the Floating shadow only to true overlays (modal, context menu, status pill).
- **Do** use Inter for every label, button, and field; keep monospace strictly inside the terminal and its preview chips.
- **Do** build hierarchy from weight and ink-lightness — the largest type in the system is a 16px title.
- **Do** let chrome hide itself when there's no choice to make (the tab strip vanishes at one tab).
- **Do** use hairline white-at-low-alpha borders (`Line` / `Line-2`) for division, never gray fills.

### Don't:
- **Don't** build an iTerm2-style configurator: no tabs-on-tabs, no floating tool panels, no preference dialogs that rival the terminal in visual weight.
- **Don't** introduce a hero or display type tier; importance is weight and ink, not scale.
- **Don't** put a drop shadow on an in-flow row or panel — shadow means "floating."
- **Don't** add decorative color, gradients-as-ornament, or glassmorphism; the backdrop blur is for the modal scrim only.
- **Don't** use monospace anywhere in the chrome.
- **Don't** use `border-left`/`border-right` greater than 1px as a colored accent stripe on rows or callouts. Selected state is carried by fill + inset ring, never a side ledge.
- **Don't** let any chrome element out-shine the terminal; if it competes for attention, tone it down.
