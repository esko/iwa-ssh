# SSH test fixture

Dockerized OpenSSH server with **vim**, **tmux**, and **fish** for local smoke tests.

## Start

```bash
cd tests/fixtures
docker compose up -d --build
```

Wait until healthy (`docker compose ps`). Default credentials:

| Field | Value |
|-------|-------|
| Host | `127.0.0.1` |
| Port | `2222` |
| User | `test` |
| Password | `test` |

The image extends `linuxserver/openssh-server` and installs interactive tools via `Dockerfile`.

## Run smoke checks

From repo root:

```bash
export SSH_HOST=127.0.0.1 SSH_PORT=2222 SSH_USER=test SSH_PASS=test
npm run smoke:ssh      # vim / tmux / fish only
npm run smoke:e2e      # SSH interactive + echo CDP + IWA checklist reminder
```

`npm run smoke:ssh` skips gracefully when the fixture is offline; it exits non-zero when the fixture is reachable but a test fails.

## Stop

```bash
docker compose down
```
