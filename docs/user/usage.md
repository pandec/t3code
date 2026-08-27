# Review usage

The Usage page combines Codex, Claude Code, and Grok Build activity from your connected
environments. It reads the providers' local session history and shows API-equivalent token cost,
processed tokens, cache savings, provider shares, and model breakdowns. Subscription billing is
separate from the raw token cost shown here.

Grok Build totals come from persisted session updates. Interactive turns that never wrote a
completed-turn record will not appear.

Two modes control which provider gets the credit. **By subscription**, the default, credits activity
to the provider whose subscription it spends rather than the app it was typed into. A gateway-routed
Claude Code session that reaches an OpenAI model counts towards Codex, and a Codex session that
reaches an Anthropic model counts towards Claude Code. **By app** credits every session to the app
that produced it.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.
