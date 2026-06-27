# Product

## Register

product

## Users

Developers on ChromeOS who connect to remote servers via SSH, Mosh, or Eternal Terminal. Power users who want a professional terminal-first experience in an IWA context — they expect the terminal to dominate the screen and the surrounding chrome to stay out of the way.

## Product Purpose

Gosh is a ChromeOS Isolated Web App that provides a profile-first SSH/Mosh/ET terminal client. The launcher organizes saved profiles and recent connections; each terminal window draws its own custom caption controls and tab strip; each tab hosts one or more Restty pane sessions with independent transports. IWA packaging, Direct Sockets, and upstream nassh/wassh runtime assets are the platform foundation.

Success looks like: a user launches a profile, connects, and spends the rest of the session entirely inside the terminal without the app chrome making any demands on their attention.

## Brand Personality

Powerful, minimal, dark. The app is capable but never loud about it. Personality is carried by precise behavior and sharp details — not by visual complexity or animated flourishes.

## Anti-references

- **iTerm2 / heavy configurator aesthetic**: tabs-on-tabs, floating panels, preference dialogs for everything, settings surfaces that rival the terminal surface in complexity. Avoid configurability-as-identity.

## Design Principles

1. **The terminal is the product.** UI chrome whispers. Every launcher, modal, settings screen, and tab strip exists to get the user into the terminal, not to compete with it.
2. **Power through restraint.** Capability is expressed through precision of behavior and correctness of defaults, not through the number of exposed controls.
3. **Native to its platform.** Custom caption, ChromeOS-matched geometry, IWA packaging — the app should feel like it belongs on ChromeOS, not ported to it.
4. **One clear session model.** Profile → tab → pane → transport. No nested abstractions, no ambiguity about what is connected. The user always knows where they are.
5. **Dark by conviction.** Dark because the user's focus is code on remote servers, not the app itself. The palette is dictated by the terminal surface, and the chrome follows.

## Accessibility & Inclusion

No formal WCAG target. Prioritize readable contrast and non-jarring interaction. Reduced-motion support on any animations. Color blindness accommodations where practical (avoid pure-color-only status indicators).
