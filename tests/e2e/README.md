# E2E smoke tests

## Automated

| Script | What it checks |
|--------|----------------|
| `npm run smoke:echo` | CDP: Vite up, connect form loads (needs `npm run dev:chrome`) |
| `npm run smoke:ssh` | SSH fixture: key auth + vim/tmux/fish over `ssh -tt` (PTY) |
| `npm run smoke:e2e` | PTY checks + echo CDP + IWA manual checklist reminder |

### SSH fixture (optional)

```bash
bash tests/fixtures/generate-keys.sh
cd tests/fixtures && docker compose up -d --build
npm run smoke:ssh    # key auth + PTY vim/tmux/fish
npm run smoke:e2e    # full orchestrator
```

Default key: `tests/fixtures/keys/smoke` (override with `SSH_KEY`).

See [tests/fixtures/README.md](../fixtures/README.md).

## Manual

| Checklist | Runtime | SSH required |
|-----------|---------|--------------|
| Echo-stub UI below | `npm run dev` in normal browser | No |
| [smoke-terminal.spec.md](./smoke-terminal.spec.md) | IWA (Dev Mode Proxy or `.swbn`) | Yes |

**Simulated mode** shows an in-app tab strip. Native ChromeOS app tabs appear after tabbed IWA install (`display_override: ["tabbed"]`).

## Setup (simulated mode)

```bash
npm install
npm run fetch-assets   # required before real SSH
npm run dev            # http://127.0.0.1:5173
# or
npm run dev:chrome     # same + opens /debug with CDP on 9222
npm run smoke:echo     # optional automated UI checks
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
