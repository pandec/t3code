# PR 78 cy-review deferred items

## Mobile provider-account email disclosure

The mobile usage account menu currently includes the full provider email in its native-menu subtitle,
while web hides the value behind an explicit reveal control. This matters for screenshots,
screen-sharing, and accessibility surfaces that announce the complete subtitle. It is not being
changed in this pass because native menus do not offer the same reveal interaction and choosing
between masking, omission, or a dedicated detail surface is a product decision. Recommend resolving
the desired mobile privacy behavior in a focused follow-up before expanding provider-account PII to
more mobile surfaces.

## Round 2

No new items were deferred. The same-ID replacement, snapshot ordering, and shared-layer ownership
findings were fixed in this pass; the mobile disclosure decision above remains the only deferred item.

> cy-review complete — 2026-07-30T13:15:38Z — rounds: 2
