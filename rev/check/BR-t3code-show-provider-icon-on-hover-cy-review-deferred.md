# Deferred items: provider icon on sidebar thread hover

## CR-03: Historical provider fallback

If a thread's provider instance is removed or its environment configuration is unavailable, the thread still retains the instance id and model but no longer has a trustworthy driver kind or display metadata for a branded icon. This means the hover affordance can be absent for those historical or disconnected rows. The current patch does not infer branding from an arbitrary instance id because custom ids do not reliably encode their driver and a generic fallback is a product choice. Follow up by deciding whether thread shells should persist provider presentation metadata or whether the sidebar should show a generic historical-provider indicator.

> cy-review complete — 2026-07-19T13:31:11+02:00 — rounds: 1
