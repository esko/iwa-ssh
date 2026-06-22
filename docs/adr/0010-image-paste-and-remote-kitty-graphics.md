# ADR 0010: Image paste and remote Kitty graphics

## Status

Accepted (2026-06-22).

## Context

Terminal image paste has two distinct meanings: render clipboard media in the
local pane, or make the original bytes available to a remote command. Mixing
the paths risks sending large escape payloads to the shell or relying on local
paths that cannot cross SSH.

Kitty's graphics protocol defines direct (`t=d`), file, temporary-file, and
shared-memory media. Only direct base64 transmission is meaningful for a
remote SSH client. SFTP is supported on Linux and macOS OpenSSH servers and
offers negotiated streaming, structured errors, and atomic filesystem actions.

## Decision

- `Ctrl+Shift+V` reads `ClipboardItem`s, prefers PNG/JPEG/WebP/GIF media over
  accompanying text, converts the first decoded frame to PNG, and injects
  quiet direct Kitty packets into the focused Restty pane. Each base64 payload
  is at most 4096 bytes. The data bypasses pane input and every remote transport.
- `Ctrl+Alt+Shift+V` preserves the original clipboard bytes, uploads through a
  lazy per-pane nassh SFTP sidecar, and inserts a POSIX-shell-quoted absolute
  path without submitting the command.
- Sidecars reuse the profile host, SSH port, username, identity staging,
  known-host store, host-key prompt, and secure-input prompt. Mosh and ET use
  their profile's SSH endpoint for this sidecar.
- Uploads are limited to 25 MiB, stored below `~/.cache/iwa-ssh/pastes/`, use
  randomized `iwa-paste-*` names, mode `0600`, a `.part` file, and atomic
  rename. App-owned files older than seven days are removed best-effort.
- Kitty file (`t=f`), temporary-file (`t=t`), and shared-memory (`t=s`) media
  are not emulated across SSH. Restty remains responsible for parsing valid
  remote direct transmissions, placements, animation, queries, and deletion.

## Consequences

Clipboard permission errors, unsupported formats, size failures, and transfer
failures are shown as terminal status and insert no terminal input. A separate
SSH connection may prompt again for authentication. Remote files can remain
for up to seven days and are readable only by their owning Unix account.

The tested renderer remains the mechanically vendored published
`@eslzzyl/restty@0.1.37`, upstream commit
`cb79ed540f76a3b38da05cf8dae8fc3d58ee67e0`; generated renderer files are not
hand-patched.
