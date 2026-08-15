import type { SessionImportCandidate } from "@t3tools/contracts";

export function getSessionImportCandidateKey(candidate: SessionImportCandidate): string {
  return `${candidate.instanceId}:${candidate.nativeSessionId}`;
}

export interface SessionImportCandidateGroups {
  /** Sessions no t3 thread owns yet; the whole row imports. */
  readonly importable: ReadonlyArray<SessionImportCandidate>;
  /** Sessions a t3 thread already continues; open or fork only. */
  readonly linked: ReadonlyArray<SessionImportCandidate>;
}

/** Splits candidates by linked state, preserving the server's order within each group. */
export function partitionSessionImportCandidates(
  candidates: ReadonlyArray<SessionImportCandidate>,
): SessionImportCandidateGroups {
  return {
    importable: candidates.filter((candidate) => candidate.linkedThread === null),
    linked: candidates.filter((candidate) => candidate.linkedThread !== null),
  };
}

export function getLinkedSessionsGroupLabel(linkedCount: number): string {
  return `Already in T3 (${linkedCount})`;
}

/**
 * Message shown in place of the importable list when it is empty; null when
 * there are importable rows to render.
 */
export function getSessionImportEmptyStateLabel(
  groups: SessionImportCandidateGroups,
): string | null {
  if (groups.importable.length > 0) {
    return null;
  }
  return groups.linked.length > 0
    ? "Every session found for this project is already in T3 Code."
    : "No sessions found for this project.";
}

/**
 * Extracts the typed reason from a failed import, whether the failure surfaced
 * as a decoded SessionImportError instance or a structurally equivalent object.
 */
export function getSessionImportFailureReason(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const tagged = error as { readonly _tag?: unknown; readonly reason?: unknown };
  if (tagged._tag !== "SessionImportError" || typeof tagged.reason !== "string") {
    return null;
  }
  return tagged.reason;
}

export function getSessionImportProviderLabel(
  candidate: SessionImportCandidate,
  showInstanceId: boolean,
): string {
  const providerLabel =
    candidate.providerDisplayName !== candidate.provider
      ? candidate.providerDisplayName
      : candidate.provider === "claudeAgent"
        ? "Claude Code"
        : candidate.provider === "codex"
          ? "Codex"
          : candidate.provider;

  return showInstanceId ? `${providerLabel} · ${candidate.instanceId}` : providerLabel;
}

export function getAmbiguousSessionImportProviders(
  candidates: ReadonlyArray<SessionImportCandidate>,
): ReadonlySet<SessionImportCandidate["provider"]> {
  const instancesByProvider = new Map<
    SessionImportCandidate["provider"],
    Set<SessionImportCandidate["instanceId"]>
  >();

  for (const candidate of candidates) {
    const instanceIds = instancesByProvider.get(candidate.provider) ?? new Set();
    instanceIds.add(candidate.instanceId);
    instancesByProvider.set(candidate.provider, instanceIds);
  }

  return new Set(
    [...instancesByProvider.entries()]
      .filter(([, instanceIds]) => instanceIds.size > 1)
      .map(([provider]) => provider),
  );
}
