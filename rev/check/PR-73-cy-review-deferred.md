# PR 73 cy-review deferred items

## 1. Explicit accent-cache startup readiness

The mobile splash coordinator waits for appearance preferences, but it does not have a reliable
signal that every known environment's persisted `ServerConfig` read has settled. A sufficiently
slow cache read could therefore allow one visible colorless frame before cached accents appear,
even though reconnect latency is no longer involved. This was not fixed because the correct
contract must distinguish “cache read completed with no config” from “still loading” across the
catalog and server-config state; approximating it with another storage cache or an unbounded splash
wait would make startup less reliable. I recommend a focused follow-up only if an integrated
cold-start trace shows a visible flash; otherwise drop it as theoretical.

> cy-review complete — 2026-07-30T05:51:04Z — rounds: 1
