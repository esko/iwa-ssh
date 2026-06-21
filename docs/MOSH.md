# Mosh

Mosh support is implemented through upstream nassh and wassh. This repo must not implement the Mosh protocol directly.

## Runtime Flow

1. User selects Mosh from a profile, the New connection dialog (protocol
   selector), or quick connect (`mosh user@host`).
2. The connection is represented as `protocol: 'mosh'` (`specFromQuery`).
3. `SshDirectSocketsTransport` gates on `checkMoshPrerequisites` (UDPSocket +
   `mosh-client.wasm`) and routes through `NasshCommandBridge` with
   `protocol: 'mosh'`, which drives the upstream nassh mosh command path.
4. Upstream nassh starts the remote `mosh-server` over a bootstrap SSH session.
5. `mosh-client.wasm` runs locally through wassh.
6. UDP traffic uses wassh socket support and the browser/IWA `UDPSocket` capability.

## Required Assets

`npm run fetch-assets` must copy:

- `app/upstream/plugin/wasm/mosh-client.wasm`
- nassh JavaScript needed by the mosh command path
- wassh socket code with UDP support
- WASI bindings required by the plugin

## Platform Requirements

- Installed IWA with Direct Sockets permission.
- `UDPSocket` available in the runtime environment.
- Remote host reachable by SSH.
- Remote host has `mosh-server` installed and available on `PATH`.
- Network permits UDP between the device and remote server.

## Failure Modes

Show clear errors for:

- `UDPSocket` unavailable.
- `mosh-client.wasm` missing.
- SSH bootstrap failure.
- `mosh-server` missing on the remote host.
- UDP blocked or timed out.
- Unsupported ChromeOS or IWA permission state.

## Acceptance

- Mosh reaches a shell on a host with `mosh-server`.
- Missing UDP produces a specific capability error.
- Missing remote `mosh-server` produces a specific server error.
- SSH remains unaffected when Mosh is unavailable.

