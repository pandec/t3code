# Codex sync presentation

Applies only to Codex. Use this alongside `SKILL.md` for semantic decision batches and completion reports. It changes presentation, not the sync workflow, approval boundaries, or ledger rules.

The reader should understand a choice without opening the code, and understand a completed sync without reconstructing a release note from feature names. Spend words on behavior and consequences; keep Git bookkeeping compact.

## Semantic decisions

Give each independent decision a numbered, bold title naming the behavior. Present the whole batch together, with enough space for each decision to stand on its own. A compact table may recap choices after their explanations, but cannot replace them.

For each decision:

1. Explain what upstream now does and what problem it solves. Explain what the fork deliberately does today and why, citing a ledger rule or documented preference when relevant.
2. Describe what happens if the incoming change is merged without adaptation. Include clean textual merges: a silently changed default or shared helper can matter as much as a conflict. Make the consequence concrete for the affected client or workflow.
3. Give realistic, labeled options. For each, say what the user would see, what fork behavior they would keep or lose, and any material maintenance cost. Include removing redundant fork code when upstream replaces it. Offer a hybrid only when it is useful, and identify behavior neither side currently has.
4. Mark the recommended option and explain why it fits the user's established choices. Mention implementation, tests, or documentation only where they clarify the consequence or cost.

Use stable decision numbers and option letters so the user can answer “1A, 2B” or approve all recommendations. A recommendation needs a reason; labels such as “keep fork,” “adopt upstream,” or “compatible” are not explanations. Scale detail to the choice, without inventing extra alternatives to fill a template.

Put the explanations in chat. If an answer tool collects short choices, reuse the same labels after the full explanations are available.

Illustrative decision shape; these are example facts, not current fork policy:

> **1. Working section defaults**
>
> Upstream now enables the Working section by default, so running threads appear together. The fork currently defaults it off and hides its controls. A clean merge would turn the section on while leaving you no visible way to turn it off.
>
> **A. Adopt upstream and restore the controls (recommended).** Working appears by default, and you can disable it in settings on web and mobile. This removes the fork's hidden-control customization and gives you control over the new default. I would update the ledger and user docs to match.
>
> **B. Keep the fork policy.** Working stays off and its controls stay hidden. I would explicitly override the incoming default on both clients; that preserves the current experience but leaves a fork override to maintain.

## Final sync report

Lead with whether the sync completed and was pushed, and any material remaining limitation. Then give **What the fork gained** real space, using separate labeled groups for **Features**, **Fixes**, and **Performance / internals** where the range warrants them. Keep refs, timing, checks, rollout, and delegation visibly separate, covering the requirements in `SKILL.md`.

- Give each significant feature or fix its own bullet, with a short bold name followed by an explanation. Usually one or two sentences suffice: what can the user now do, or what previously went wrong and now works? Add where to find or use it when that helps.
- Keep distinct capabilities separate even when they share a category. A single “Features:” bullet containing a comma- or semicolon-separated inventory recreates the problem. Group only closely related minor changes whose shared consequence can be explained together.
- Explain substantive gains across the pinned incoming range, including changes that merged cleanly. Do not limit the report to conflicts, or turn every commit into a bullet. Small changes need small reports; broad syncs need enough room for their important gains.
- For internal work, explain the operational consequence: less repeated parsing, earlier renderer loading, fewer database reads. Claim measured speedups only when supported by evidence.
- Flag overlap with fork customizations beside the relevant gain. Explain behavior-changing resolutions in their own labeled block: the resulting behavior, what was preserved or removed, and why. Keep incoming capabilities distinguishable from integration repairs.
- State whether a feature is available after updating, requires configuration, or remains disabled by fork policy. Code being merged does not mean an installed app has been updated or a feature enabled.

Illustrative gain entries; use only facts verified for the current sync:

> **Features**
>
> - **One-time schedules.** A task can run once at a chosen date and time, without configuring a recurring schedule. Update older clients before creating one, because they cannot decode the new schedule type.
> - **Usage filters.** Usage totals can be limited to selected transcript providers and models through `usageModelFilter`. The fork keeps subscription-pool reporting, and filtering uses the recorded provider/model before display aliases are applied.
>
> **Fixes**
>
> - **Preview focus.** An agent using the browser preview no longer steals focus from the composer while you are typing.
>
> **Performance / internals**
>
> - **Desktop startup.** The renderer loads while the backend starts, rather than waiting for backend readiness before showing the window. The fork retains its Dev identity and update behavior.

Before sending, check the two outcomes: could the user choose from each decision using its explanation alone, and could they explain what each significant gain changes without looking it up? Expand any entry that is still only a name or technical shorthand.
