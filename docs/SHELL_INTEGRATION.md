# Shell integration (OSC 7 working directory)

The terminal's right-click **Copy path** reports the remote shell's current
working directory. iwa-ssh reads it from the standard **OSC 7** escape sequence
(`ESC ] 7 ; file://HOST/PATH ST`). A remote shell that doesn't emit OSC 7 will
have no directory to report, so Copy path falls back to the connection target
(`user@host`).

To enable it, have the remote shell emit OSC 7 on each prompt. Add one of these
to the remote `~/.bashrc` / `~/.zshrc` (most distros already ship this in
`/etc/profile.d/`):

## bash

```bash
__iwa_osc7() { printf '\033]7;file://%s%s\033\\' "$HOSTNAME" "$PWD"; }
PROMPT_COMMAND="__iwa_osc7${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
```

## zsh

```zsh
__iwa_osc7() { printf '\033]7;file://%s%s\033\\' "$HOST" "$PWD"; }
precmd_functions+=(__iwa_osc7)
```

## fish

```fish
function __iwa_osc7 --on-event fish_prompt
    printf '\033]7;file://%s%s\033\\' (hostname) "$PWD"
end
```

Paths with spaces or non-ASCII characters should be percent-encoded; iwa-ssh
percent-decodes whatever the shell sends. Once enabled, Copy path returns the
live remote directory.
