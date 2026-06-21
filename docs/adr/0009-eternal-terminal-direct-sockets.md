# ADR 0009: Eternal Terminal over IWA Direct Sockets

## Status

Accepted (2026-06-21).

## Decision

Support Eternal Terminal as a third connection protocol alongside SSH and
Mosh. The app implements ET protocol version 6 in TypeScript and connects to
`etserver` with an IWA `TCPSocket`; it does not compile the C++ ET client to
WebAssembly.

The ET socket, framing, crypto, keepalive, and recovery loop run in a dedicated
worker owned by the terminal document. Closing the final app window therefore
still closes the client socket; persistence means the next app window can
reattach to the server-held shell, not that a browser worker survives shutdown.

New sessions bootstrap over the existing nassh/wassh SSH transport by running
`etterminal`, then connect directly to the ET TCP port (2022 by default).
Reconnects do not require SSH. ET is one real transport per restty pane or
in-window tab, consistent with ADR 0008; native application tabs are not part
of this design.

The wire implementation is pinned to Eternal Terminal commit
`636858444906e24e9a4271403bd909c64eeb1527`. `scripts/fetch-et-protocol.mjs`
mechanically refreshes the protobuf schemas and generated TypeScript. ET's
XSalsa20-Poly1305 SecretBox payloads use `libsodium-wrappers`; WebCrypto is used
only to wrap the 32-byte ET passkey at rest.

## Persistence and lifecycle

- IndexedDB stores an opaque local session id, wrapped passkey, peer sequence
  counters, already-encrypted outbound recovery packets, and an encrypted
  64 MiB output journal.
- The launcher lists resumable sessions. URLs contain only the opaque local id.
- Closing a pane, tab, or the final window detaches the client and retains the
  remote shell. Reopening the IWA and selecting the session performs ET's
  returning-client catch-up exchange.
- A Web Lock prevents two tabs or windows from attaching the same ET session.
- ET recovery buffers and visual replay are bounded at 64 MiB. Replaying a
  truncated journal displays a notice.
- `INVALID_KEY` marks a local entry stale because an `etserver` restart or
  remote shell exit cannot be resumed.
- Forget removes local credentials and replay data. It does not claim to kill
  a possibly running remote shell.

The origin-local, non-extractable AES-GCM key protects against casual database
inspection, not malicious same-origin code. Clearing site data or uninstalling
the IWA removes the ability to resume stored sessions.
