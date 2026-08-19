# Review usage

The Usage page combines Codex and Claude Code activity from your connected environments. It reads
the providers' local session history and shows API-equivalent token cost, processed tokens, cache
savings, provider shares, and model breakdowns. Subscription billing is separate from the raw token
cost shown here.

Activity is credited to the provider whose subscription it spends, not the app it was typed into.
When a gateway routes a Claude Code session to an OpenAI model, that model's tokens count towards
Codex, and a Codex session that reaches an Anthropic model counts towards Claude Code.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.
