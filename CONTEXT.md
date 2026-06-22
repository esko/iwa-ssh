# Domain Context

## Product hierarchy

- A **terminal window** is one unframed IWA window with custom caption controls.
- A terminal window contains one or more app-rendered **tabs**.
- A tab contains one or more Restty-native **pane sessions**.
- Each pane session owns exactly one **transport** and may own one Eternal Terminal **resume identity**.

## Connection language

A **connection intent** is the reusable, normalized description used to open a
pane session. It identifies an SSH, Mosh, or Eternal Terminal destination and
its profile, identity, settings, and startup-command references. A resume
identity is runtime state owned by one ET pane session; it is not shared by a
tab or window.

Restty is the sole product renderer. A transport writes to a narrow
`TerminalSink`; renderer layout, focus, appearance, titles, tabs, and splits do
not belong in the transport boundary.

Multiple terminal windows remain valid. Native platform tabs are not part of
the product architecture.
