# SSH test fixture

Dockerized OpenSSH server with **vim**, **tmux**, and **fish** for local smoke tests.

Auth is **key-based** (fixture Ed25519 key). Password login is disabled.

## One-time: generate fixture keys

```bash
bash tests/fixtures/generate-keys.sh
```

Creates `tests/fixtures/keys/smoke` and `smoke.pub` (no passphrase, fixture-only).

## Start

```bash
cd tests/fixtures
docker compose up -d --build
```

Wait until healthy (`docker compose ps`).

| Field | Value |
|-------|-------|
| Host | `127.0.0.1` |
| Port | `2222` |
| User | `test` |
| Private key | `tests/fixtures/keys/smoke` |

The image extends `linuxserver/openssh-server`, installs interactive tools, and loads `smoke.pub` via `PUBLIC_KEY_FILE`.

## Run smoke checks

From repo root:

```bash
npm run smoke:ssh      # vim/tmux/fish over ssh -tt (PTY)
npm run smoke:e2e      # PTY checks + echo CDP + IWA manual checklist
```

Override target:

```bash
export SSH_HOST=127.0.0.1 SSH_PORT=2222 SSH_USER=test SSH_KEY=tests/fixtures/keys/smoke
npm run smoke:ssh
```

Scripts skip gracefully when the fixture is offline; they exit non-zero when reachable but a test fails.

**Note:** PTY smoke tests verify remote packages over `ssh -tt`. Full-screen terminal UI in the IWA still requires the manual checklist in `tests/e2e/smoke-terminal.spec.md`.

## Stop

```bash
docker compose down
```
