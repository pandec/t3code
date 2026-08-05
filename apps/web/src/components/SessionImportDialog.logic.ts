import type { SessionImportCandidate } from "@t3tools/contracts";

export function getSessionImportCandidateKey(candidate: SessionImportCandidate): string {
  return `${candidate.instanceId}:${candidate.nativeSessionId}`;
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
