# Legacy PWA Frontend Replacement Plan

## North star

Use the profile-first legacy-PWA shape with an unframed custom caption. A
terminal window owns app-rendered tabs; each tab owns Restty pane sessions; each
pane owns its connection intent, transport, and optional ET resume identity.

## Active slices

1. [#47](https://github.com/esko/gosh/issues/47): align product truth,
   remove Wterm and native-tab code, and keep Restty plus `TerminalSink`.
2. [#48](https://github.com/esko/gosh/issues/48): canonicalize connection
   intent and make echo development-only.
3. [#49](https://github.com/esko/gosh/issues/49): move tab/pane lifecycle
   behind `TerminalWindowController`.
4. [#50](https://github.com/esko/gosh/issues/50): move ET worker and lock
   lifecycle behind `EtWorkerController`.

Slices land sequentially. Every slice changes the installed IWA, bumps all four
version files, and passes focused tests, the full test suite, typecheck, build,
and `git diff --check` before the next slice branches.

## Device acceptance

- Custom caption tabs and shortcuts work in the installed IWA.
- Restty splits create independent SSH sessions.
- Pane/tab close and reconnect affect only their owning sessions.
- ET detach, resume, contention, and stale cleanup release resources exactly once.
- Production rejects echo and the bundle contains no Wterm or native-tab path.
