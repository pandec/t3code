// Enough hits to look past same-named neighbours (`ChatView.test.tsx`) without
// asking for a full listing on a single click.
export const WORKSPACE_BASENAME_LOOKUP_LIMIT = 25;

// One counter per scope (scoped thread key): within a pane the newest click
// wins, but a click in one split pane must not cancel the other pane's
// in-flight lookup — they open different panels.
const latestLookupSequenceByScope = new Map<string, number>();

/** Call the returned predicate when the search settles; false means a later click superseded it. */
export function claimWorkspaceBasenameLookup(scopeKey = ""): () => boolean {
  const claimed = (latestLookupSequenceByScope.get(scopeKey) ?? 0) + 1;
  latestLookupSequenceByScope.set(scopeKey, claimed);
  return () => claimed === latestLookupSequenceByScope.get(scopeKey);
}

export interface WorkspaceEntryCandidate {
  readonly path: string;
  readonly kind: "file" | "directory";
}

function basenameOfPath(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

export function needsWorkspaceBasenameLookup(relativePath: string): boolean {
  const trimmed = relativePath.trim();
  return trimmed.length > 0 && !trimmed.includes("/") && !trimmed.includes("\\");
}

export function pickWorkspaceBasenameMatch(
  basename: string,
  entries: ReadonlyArray<WorkspaceEntryCandidate>,
): string | null {
  const target = basename.trim();
  if (!target) return null;
  const files = entries.filter((entry) => entry.kind === "file");
  const exact = files.find((entry) => basenameOfPath(entry.path) === target);
  if (exact) return exact.path;
  // Folded matching covers casing that drifted from disk, but `FOO.ts` against
  // both `Foo.ts` and `foo.ts` has no right answer, so it resolves to nothing
  // rather than opening whichever the index ranked first.
  const folded = target.toLowerCase();
  const foldedMatches = files.filter(
    (entry) => basenameOfPath(entry.path).toLowerCase() === folded,
  );
  return foldedMatches.length === 1 ? (foldedMatches[0]?.path ?? null) : null;
}
