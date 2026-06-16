# Smoke: interactive terminal (SSH wired)

Manual checklist for **real SSH sessions** — vim, tmux, and fish. Requires:

- IWA install (Dev Mode Proxy or signed `.swbn`) — see [docs/IWA_DEV_SETUP.md](../../docs/IWA_DEV_SETUP.md)
- `npm run fetch-assets` completed; `/debug` shows **Upstream assets: ready**
- `/debug` shows **TCPSocket: yes**
- A reachable `sshd` (Linux VM, Pi, etc.) and credentials or key

Remote should have `vim`, `tmux`, and `fish` available (install if missing).

## Pre-flight

- [ ] App launched from launcher (`isolated-app://` origin)
- [ ] `/debug` → **IWA origin** yes, **TCPSocket** yes, **Upstream assets** ready
- [ ] Connect to host succeeds; remote shell prompt visible
- [ ] `echo $TERM` prints `xterm-256color` (or acceptable xterm variant)

---

## 1. vim

| Step | Action | Pass |
|------|--------|------|
| 1.1 | Run `vim -u NONE` | Full-screen vim UI, no garbage characters |
| 1.2 | Press `i`, type `hello`, **Esc** | Insert mode works; `-- INSERT --` or cursor moves |
| 1.3 | `:wq` **Enter** | Exits cleanly back to shell |
| 1.4 | `vim -u NONE` again; **Ctrl+C** then `:q!` | Force quit works |
| 1.5 | Resize browser/IWA window while in vim | `vim` redraws; no permanent blank areas |
| 1.6 | Arrow keys and **Home**/**End** in normal mode | Cursor moves correctly |

---

## 2. tmux

| Step | Action | Pass |
|------|--------|------|
| 2.1 | `tmux new -s smoke` | Status bar visible; shell inside tmux |
| 2.2 | **Ctrl+B** then `%` (split vertical) | Two panes; both accept input |
| 2.3 | **Ctrl+B** then arrow keys | Focus changes between panes |
| 2.4 | `exit` in one pane, then `exit` in the other | Returns to outer shell |
| 2.5 | `tmux new -s smoke2`; **Ctrl+B** then `d` | Detach; outer prompt returns |
| 2.6 | `tmux attach -t smoke2` | Session reattaches with prior state |

---

## 3. fish

| Step | Action | Pass |
|------|--------|------|
| 3.1 | `fish` | Fish greeting/prompt; colors render |
| 3.2 | Type partial command, **Tab** | Completion or sensible beep |
| 3.3 | `echo (seq 1 3)` | Command substitution works |
| 3.4 | **Up** / **Down** | History navigation |
| 3.5 | `exit` | Returns to default shell |

---

## 4. Regression spot-checks

| Step | Action | Pass |
|------|--------|------|
| 4.1 | **Ctrl+Shift+C** / **Ctrl+Shift+V** in tmux pane | Copy/paste round-trip |
| 4.2 | Open second session tab; both stay connected | Independent sessions |
| 4.3 | Disconnect Wi‑Fi briefly, reconnect | Error overlay or reconnect usable |

---

## Notes

- Failures in **1.5** often indicate missing SIGWINCH / resize forwarding to wassh.
- Garbled full-screen apps: check `TERM`, UTF-8 locale on server (`LANG=en_US.UTF-8`).
- For Dev Mode Proxy debugging, use DevTools **Network** → Direct Sockets (Chrome 138+).
