# E2E smoke tests (manual)

Automated Playwright/CDP tests are not wired yet. Use these checklists to verify the terminal UI and app shell before and after SSH wiring.

## When to run

| Checklist | Runtime | SSH required |
|-----------|---------|--------------|
| This file (simulated mode) | `npm run dev` or `npm run dev:chrome` in a normal browser tab | No — echo stub is enough |
| [smoke-terminal.spec.md](./smoke-terminal.spec.md) | IWA via Dev Mode Proxy or signed `.swbn` | Yes — real `sshd` |

**Simulated mode** shows an in-app tab strip (`simulated tabs` badge). Native ChromeOS app tabs appear only after a tabbed IWA install (`display_override: ["tabbed"]`).

## Setup (simulated mode)

```bash
npm install
npm run fetch-assets   # optional for these UI tests; required before real SSH
npm run dev            # http://127.0.0.1:5173
# or
npm run dev:chrome     # same + opens /dev with CDP on 9222
```

Open `http://127.0.0.1:5173/` in Chrome. Confirm the tab strip badge reads **simulated tabs**.

## Smoke: shell input (echo stub)

Runs against the local echo stub when upstream wassh is unavailable, or against a live session after SSH is wired.

1. **Connect** or **Debug → Open session tab** with any host (e.g. `dev.local`).
2. Wait for status **Connected** and a `$` prompt.
3. Type `hello` — characters appear on screen.
4. Press **Enter** — new line and `$` prompt (echo stub) or remote echo (live SSH).
5. Press **Backspace** on a partial line — last character erases.

**Pass:** keyboard input and Enter behave predictably; no frozen terminal.

## Smoke: terminal resize

1. Open a session tab; focus the terminal (`#terminal-host`).
2. Shrink the browser window width/height — xterm reflows; prompt stays visible.
3. On `/debug`, use **Open in this tab** for a session, then resize — same behavior.

**Pass:** no blank terminal, no overlapping toolbar; `FitAddon` keeps content in view.

**Optional (live SSH):** run `vim` on the remote host, split/resize window — see [smoke-terminal.spec.md](./smoke-terminal.spec.md).

## Smoke: copy and paste

1. In a session, type a unique string (e.g. `copy-test-42`).
2. Select text in the terminal with the mouse.
3. **Ctrl+Shift+C** (copy) / **Ctrl+Shift+V** (paste) — or context menu if available.
4. Paste at the prompt — full string appears.

**Pass:** round-trip copy/paste works; no duplicated control characters.

## Smoke: simulated tabs

1. From **Home**, click **Connect** — tab strip shows **Connect** tab.
2. **Debug → Open session tab** — new tab appears; first tab unchanged.
3. Switch tabs via strip — correct route loads each time.
4. **Ctrl+W** (or tab close button) — tab closes; another tab becomes active.
5. **Ctrl+T** or **+** — new **Home** tab.
6. **Duplicate tab** on a session — second session tab opens.

**Pass:** open, switch, close, and duplicate behave without full page reload glitches.

## Reporting

Record Chrome version, `Runtime` line from `/debug`, and pass/fail per section. File issues for regressions with steps and screenshots.
