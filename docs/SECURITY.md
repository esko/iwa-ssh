# Security

iwa-ssh is a **high-trust IWA** — packaged, signed, isolated. Security choices below are intentional for personal SSH use on ChromeOS.

## Credentials

| Rule | Implementation |
|------|----------------|
| **No plaintext passwords** | Key-based auth only; no password field in profiles or storage |
| **Encrypted private keys** | **Not yet implemented** — see `privateKeyPemBytesDevOnly` below |
| **No silent auth** | Connecting requires explicit user action (connect button / profile select) |

Passphrase is never written to IndexedDB or export JSON.

### Implemented (MVP)

- **Key import UI** (`app/src/ssh/KeyImport.ts`): OpenSSH private key PEM via file or paste; public key extracted and stored.
- **Identity picker** on connect and profile editor with import button.
- **No password fields** anywhere in the UI or storage layer.

### Dev-only / not production-ready

- **`Identity.privateKeyPemBytesDevOnly`**: raw PEM bytes at rest (misleading name avoided on purpose). Field name signals that WebCrypto encryption is not implemented.
- **Passphrase prompt at connect** for encrypted PEM keys (import accepts bcrypt-protected keys but SSH auth cannot use them yet).

### Deferred

- **WebCrypto passphrase encryption** of private keys at rest.
- **SSH auth wiring** — identities stage into nassh FS when upstream assets are present; encrypted-at-rest keys pending.

## Host trust

| Rule | Implementation |
|------|----------------|
| **known_hosts store** | `KnownHost` records in IndexedDB (`host:port` → fingerprint) |
| **Trust prompt** | Unknown/changed host keys require user confirmation before connect |
| **No LAN scanning** | No discovery, broadcast, or background connection attempts |

### Implemented (MVP)

- **Trust modal** (`app/src/ssh/KnownHostPrompt.ts`): UI for host trust decisions.
- **Connect gate** (`app/src/routes/connect.ts`): `ensureHostTrusted()` runs before navigating to a session.
- **Dev inspector** (`/debug`, development only): host-trust probe exercises the modal.

### Dev-only / not production-ready

- **Host key verification is stubbed** (`isHostKeyVerificationStubbed()`): fingerprints are placeholders (`SHA256:STUB-…`). The modal states this explicitly; **Trust always** is hidden and nothing is persisted while stubbed.
- **Stub-era `knownHosts` records** (if any) used fake fingerprints and should be cleared before real verification lands.

### Deferred

- **Live host key fingerprint** from wassh over Direct Sockets.
- **Session reconnect** does not re-prompt (trust is checked at connect-screen submit only).
- **Removing or editing** known host entries in settings UI.

## Network

| Rule | Implementation |
|------|----------------|
| **Direct TCP only (MVP)** | `TCPSocket` via Direct Sockets; no relay/proxy fallback |
| **User-initiated** | No connections without explicit connect action |
| **SSH to declared host:port** | Profile stores target; no redirect to arbitrary endpoints |

SSH traffic uses upstream wassh via nassh `CommandInstance` (`--field-trial-direct-sockets`). `DirectSocketProbe.ts` is for capability checks only (e.g. `/debug`).

## Content Security Policy

IWA bundles enforce strict CSP (set via bundle `headerOverride` in `iwa/webbundle.config.ts`):

```text
script-src 'self' 'wasm-unsafe-eval'
connect-src 'self' https: wss: blob: data:
default-src 'self'
object-src 'none'
base-uri 'none'
style-src 'self' 'unsafe-inline'
```

`require-trusted-types-for 'script'` is **omitted during MVP** because the app shell renders via `innerHTML` without a Trusted Types policy yet.

Cross-origin isolation headers:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

## Bundle integrity

| Rule | Notes |
|------|-------|
| **No remote scripts** | All JS/WASM/CSS/fonts ship inside the signed `.swbn` |
| **No CDN runtime deps** | xterm, app code bundled at build time |
| **Signed updates** | Optional; local-only installs use `.swbn` from disk without an update server |
| **Stable identity** | Web Bundle ID derived from signing key — rotate key = new app |

`'wasm-unsafe-eval'` is required for OpenSSH WASM (wassh). No `'unsafe-inline'` for scripts.

## Storage isolation

- IWA storage is separate from normal browser profile storage
- Each Web Bundle ID gets its own `isolated-app://` origin
- Export JSON omits private key bytes (`hasPrivateKeyDevOnly` flag only)

## Dev mode caveats

IWA Dev Mode Proxy assigns a **random** bundle ID — fine for development, not for security testing of updates/signing.

Do not use dev proxy installs for secrets you would not put in a normal browser tab on an untrusted network.

## Non-goals (MVP)

- Password authentication
- Agent forwarding
- Port forwarding UI
- Automatic trust of all hosts on a subnet
- Telemetry or remote crash reporting

## Reporting

For upstream Secure Shell security issues, see [Chromium security](https://www.chromium.org/Home/chromium-security/). For this fork, use the project issue tracker.
