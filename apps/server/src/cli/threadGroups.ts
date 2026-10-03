import type { ThreadGroup } from "@t3tools/contracts";
import { visibleThreadGroups } from "@t3tools/shared/threadGroups";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// Whole keycaps (1️⃣, #️⃣) first, so their base character goes with them; then
// emoji code points plus the joiners, variation selectors, and flag tag
// characters that glue them together. Digits, `#`, and `*` are Emoji-property
// code points too, so the broad \p{Emoji} class would eat real name characters.
// The combining marks sit outside the class so each is matched on its own.
const EMOJI_PATTERN =
  /[0-9#*]\u{FE0F}?\u{20E3}|[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u{200D}\u{E0020}-\u{E007F}]|\u{20E3}|\u{FE0E}|\u{FE0F}/gu;

/** Loose comparison form of a group name: emoji dropped, whitespace runs
    collapsed, case folded. "🔥 Release  &  🪜 Marketing" -> "release & marketing". */
export function normalizeThreadGroupName(name: string): string {
  return name.replace(EMOJI_PATTERN, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

export type ThreadGroupMatch =
  | { readonly kind: "found"; readonly group: ThreadGroup }
  | { readonly kind: "ambiguous"; readonly candidates: ReadonlyArray<ThreadGroup> }
  | { readonly kind: "not-found"; readonly groups: ReadonlyArray<ThreadGroup> };

/** Resolve a group by id, then exact name, then loose name. Each stage only
    runs when the stricter one found nothing, so an exact name still wins
    over loose look-alikes; more than one hit at a stage is ambiguous. */
export function matchThreadGroup(
  catalog: ReadonlyArray<ThreadGroup>,
  query: string,
): ThreadGroupMatch {
  const groups = visibleThreadGroups(catalog);
  const trimmed = query.trim();
  const byId = groups.find((group) => group.id === trimmed);
  if (byId) return { kind: "found", group: byId };
  const normalized = normalizeThreadGroupName(trimmed);
  for (const matches of [
    groups.filter((group) => group.name === trimmed),
    normalized.length === 0
      ? []
      : groups.filter((group) => normalizeThreadGroupName(group.name) === normalized),
  ]) {
    if (matches.length === 1) return { kind: "found", group: matches[0]! };
    if (matches.length > 1) return { kind: "ambiguous", candidates: matches };
  }
  return { kind: "not-found", groups };
}

const describeGroups = (groups: ReadonlyArray<ThreadGroup>) =>
  groups.map((group) => `${group.name} (${group.id})`).join("; ");

export class ThreadCliGroupError extends Schema.TaggedError<ThreadCliGroupError>()(
  "ThreadCliGroupError",
  {
    operation: Schema.Literal("resolveThreadGroup"),
    query: Schema.String,
    reason: Schema.Literals(["not-found", "ambiguous"]),
    /** `name (id)` entries joined by `; `: the ambiguous matches, or every
        available group when nothing matched. */
    candidates: Schema.String,
  },
) {
  override get message(): string {
    if (this.reason === "ambiguous") {
      return `Group '${this.query}' is ambiguous. Matching groups: ${this.candidates}. Pass a group id or the exact name.`;
    }
    return this.candidates.length === 0
      ? `No group '${this.query}' exists; this environment has no thread groups.`
      : `No group '${this.query}' exists. Available groups: ${this.candidates}.`;
  }
}

export const resolveThreadGroup = (
  catalog: ReadonlyArray<ThreadGroup>,
  query: string,
): Effect.Effect<ThreadGroup, ThreadCliGroupError> => {
  const match = matchThreadGroup(catalog, query);
  if (match.kind === "found") return Effect.succeed(match.group);
  return Effect.fail(
    new ThreadCliGroupError({
      operation: "resolveThreadGroup",
      query,
      reason: match.kind,
      candidates: describeGroups(match.kind === "ambiguous" ? match.candidates : match.groups),
    }),
  );
};
