---
target: connect modal
total_score: 31
p0_count: 0
p1_count: 0
timestamp: 2026-06-23T06-27-20Z
slug: connect-modal-openconnectionform
---
# Connect Modal Critique — iwa-ssh

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Native required focuses the bad field; passphrase reveals on key entry; but no autofocus and no "connecting…" state on submit |
| 2 | Match System / Real World | 3 | "address" where SSH users expect "Host"; "Eternal Terminal" spelled out (good) |
| 3 | User Control and Freedom | 4 | Cancel, Escape, and click-outside all close cleanly |
| 4 | Consistency and Standards | 2 | The native light "Choose File" button breaks the dark system; everything else is cohesive |
| 5 | Error Prevention | 3 | Native required on host/user, numeric port bounds, smart defaults (22 / 2022); no hostname format check |
| 6 | Recognition Rather Than Recall | 4 | Strong placeholders ("192.168.1.60", "esko", "defaults to user@host") + inline hints |
| 7 | Flexibility and Efficiency | 3 | Enter submits, Tab order works; but no autofocus means a click before typing |
| 8 | Aesthetic and Minimalist | 3 | Clean, but paste-textarea + file-picker + passphrase all expand at once → a long, scrolling form |
| 9 | Error Recovery | 3 | Passphrase error is clear but sits at the bottom by the buttons, far from the key field |
| 10 | Help and Documentation | 3 | Good inline teaching hints ("encrypts the key on this device", "replace existing") |
| **Total** | | **31/40** | **Good — one jarring control, an over-long form, minor copy/a11y gaps** |

## Anti-Patterns Verdict

**LLM assessment:** Does not read as AI-generated. On-brand dark Quiet Cockpit form, the resolved raised-dark Connect primary against a genuinely quiet Cancel, consistent inputs with the custom select caret. The single tell is the **un-styled native file input** — a light OS control dropped into a dark custom form, which the product register explicitly warns against ("mismatched form controls").

**Deterministic scan:** `detect.mjs` on the form markup is clean (0 findings).

**Visual evidence:** Inspected live in three states — default, key-pasted (passphrase reveals), and empty-submit (native validation focuses `host`). Findings are grounded in those, not inferred.

## Overall Impression

A competent, on-brand connection form with genuinely good progressive disclosure (passphrase appears only with a key; ET port only for ET). Two things hold it back: the **native file-input clashes** with everything around it, and the **SSH-key section is always fully expanded** — paste box + file picker + passphrase — which makes the default form long and scrolling when the 90% case (host/user/protocol) is three fields. The single biggest win is collapsing the key section so the common path is short and the file control stops breaking the theme.

## What's Working

1. **Progressive disclosure.** Passphrase reveals only when a key is provided; ET port only when protocol is ET. The form shows what's needed, hides the rest — exactly right.
2. **Recognition over recall.** Every field has a realistic placeholder and the optional/replace hints are doing real teaching work. A first-timer can fill this without docs.
3. **Clean exits + on-brand controls.** Cancel / Escape / click-outside all close; the Connect/Cancel pair reads correctly as primary/secondary in the dark system.

## Priority Issues

- **[P2] Native file-input breaks the system.** The light "Choose File / No file chosen" OS control is the one element that doesn't belong in the dark form. The project already solved this exact problem in Settings → Appearance (a styled "Upload…" ghost button that triggers a hidden `<input type=file>`).
  - **Fix:** Reuse that pattern — hide the native input, trigger it from a `.btn-ghost`, and show the chosen filename in muted text.
  - **Suggested command:** /impeccable harden

- **[P2] The form is long; the key section is always expanded.** Paste textarea + file picker + (conditionally) passphrase stack up, so the modal scrolls even though the common case is name/address/user/port/protocol. The two key-entry methods shown side by side ("paste a key" AND "choose a file") also pose a needless either/or.
  - **Fix:** Collapse the whole SSH-key block behind a quiet "Add SSH key" disclosure; default the form to the essentials. Inside, offer paste-or-file as one unit.
  - **Suggested command:** /impeccable distill

- **[P2] The inline error isn't announced.** The passphrase error `<p data-err>` has no `role="alert"` / `aria-live`, so a screen reader never hears it; it's also positioned at the bottom by the buttons rather than next to the key/passphrase field it describes.
  - **Fix:** Add `role="alert"`, move it adjacent to the passphrase field.
  - **Suggested command:** /impeccable harden

- **[P3] "address" mismatches SSH convention.** Users expect "Host" or "Hostname"; "address" is understandable but off-key for the audience.
  - **Fix:** Rename the label to "host".
  - **Suggested command:** /impeccable clarify

- **[P3] No autofocus + no submit feedback.** The modal opens with focus on `<body>`, so typing needs a click first; and Connect gives no "connecting…" / disabled state during the async key-encrypt + navigate.
  - **Fix:** Autofocus the first empty required field on open; disable Connect with a label change while the submit runs.
  - **Suggested command:** /impeccable harden

## Persona Red Flags

**Alex (Power User):** No autofocus — has to click before typing the host. Otherwise efficient: Enter submits, Tab order is sane, Escape cancels.

**Jordan (First-Timer):** "address" is ambiguous (IP? hostname? URL?). Two key-entry methods shown at once ("paste a private key" and "choose a key file") raise an unanswered "which one?" The strong placeholders rescue most of this.

**Sam (Accessibility):** Labels are implicitly associated (label-wrap) and native required gives validation — good. But the error `<p>` isn't an `aria-live`/`alert` region, so the passphrase error is silent to screen readers, and the native file button, while focusable, is the lone control that won't match a high-contrast dark expectation.

## Minor Observations

- The key textarea renders the pasted private key in the UI sans (Inter); keys are conventionally monospace and easier to verify that way — but the "Mono-Stays-Inside" rule forbids chrome monospace, so this is a real tension, not an obvious fix.
- The private key is shown in plaintext as typed — standard for a key-import field, but worth a deliberate decision.
- Port and ET port both default sensibly (22 / 2022); good.

## Questions to Consider

- Should the SSH-key section be collapsed by default so the 90% case (host/user/protocol) is a short three-field form?
- Is "address" deliberate, or should it be "Host" to match every other SSH tool the user knows?
- The key textarea in sans vs mono — is a private key the one place a monospace exception earns its keep, or does "Mono-Stays-Inside" win?
