# PR 78 cy-review deferred items

## Mobile provider-account email disclosure

The mobile usage account menu currently includes the full provider email in its native-menu subtitle,
while web hides the value behind an explicit reveal control. This matters for screenshots,
screen-sharing, and accessibility surfaces that announce the complete subtitle. It is not being
changed in this pass because native menus do not offer the same reveal interaction and choosing
between masking, omission, or a dedicated detail surface is a product decision. Recommend resolving
the desired mobile privacy behavior in a focused follow-up before expanding provider-account PII to
more mobile surfaces.

> cy-review complete — 2026-07-30T12:53:15Z — rounds: 1
