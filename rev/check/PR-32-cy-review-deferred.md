# Cy-review deferred items: PR 32 final agent navigator

## Imported history finality

Imported history events contain role, text, timestamp, and message ID, but no turn outcome or final-response
metadata. Treating every imported assistant message as final could put commentary into the navigator, which
would violate the feature's core contract. The navigator therefore conservatively omits imported assistant
history until the import contract carries authoritative turn/finality metadata. Revisit alongside provider
history import enrichment.

## Delayed non-latest turn completion

A delayed assistant completion event for an older, non-latest turn cannot be classified deterministically
by the live client reducer because the event carries no prior turn outcome. The persisted server projection
is authoritative and the next snapshot converges the navigator. A fully live fix requires a server-authored
final-response delta or per-message finality field; add that only if this provider ordering occurs in
practice, because it broadens the event protocol for a transient convergence edge case.
