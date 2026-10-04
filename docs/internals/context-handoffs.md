# Context handoffs

Portable provider handoffs, fork merge-backs, and legacy v1 imports deliver a budgeted selection of
intact app history. They do not claim native provider context parity: provider-native session state,
tool state, approvals, reasoning, and attachments are never reconstructed.

`ContextHandoffServiceV2` records each handoff with structured `history`: the selected messages, a
coverage marker that points to `t3_thread_read`, and the omitted item IDs. `historicalMessage` in
`ContextHandoffBudget.ts` decides which turn items become messages, and `selectHistory` chooses them
within `T3CODE_CONTEXT_HANDOFF_TOKEN_CAP`. Selected items keep their full text; an item that does not
fit is omitted whole and stays retrievable through the coverage marker. Provider handoffs cover the
full eligible history or the delta since that provider last participated; fork merge-backs cover the
child's delta; legacy imports cover the migrated v1 messages.

`ContextHandoffDelivery` merges pending handoffs at turn start and re-selects within the remaining
context budget. It injects native history when the adapter supports it and otherwise renders the
selection into the provider input. Delivery status is persisted per native thread before and after
injection; an ambiguous pending delivery fails the turn so the native thread is replaced instead of
receiving the history twice.

`summaryText` is a display and fallback representation, not the delivery algorithm. Fork merge-backs
store a line-per-item summary that compacts text to 240 characters, and legacy imports store a
transcript suffix within 32,000 characters. Delivery uses `summaryText` only for older handoff records
without `history`, and includes it only when it fits the budget. User-facing behavior and limits are
in [Context in portable handoffs](../user/portable-handoffs.md).
