# PR #2 Cy Review Deferred Items

## CY-5: Synthetic active turns can bypass the pending extension cap

Claude can create a synthetic turn when background output arrives without a user turn, and that turn may remain active until a later prompt closes it. The reaper skips every projected active turn before applying `maxPendingExtensionMs`, so a stale synthetic turn can keep the provider session alive indefinitely and bypass the intended 24-hour safety cap. This was not fixed in PR #2 because the persisted turn/session projection does not distinguish synthetic turns from legitimate long-running work, and reaping all old active turns would introduce a more serious correctness risk. Follow up by persisting an explicit synthetic/background lifecycle signal and defining a safe expiry policy; do not drop the issue, but keep it separate from this pending-deliverables fix.

> cy-review complete — 2026-07-15T12:12:13Z — rounds: 1
