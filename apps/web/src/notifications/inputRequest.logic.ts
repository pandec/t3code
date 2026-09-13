import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

type InputRequestKind = "approval" | "input";

export interface InputRequestCandidate {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly kind: InputRequestKind;
  readonly title: string;
}

/**
 * The thread's blocking request, keyed to the turn it belongs to so the same
 * request cannot re-fire when a timestamp or ordering field is re-serialized.
 * Approval outranks input, matching the sidebar status pill.
 */
function inputRequestKey(shell: EnvironmentThreadShell): string | null {
  const kind = inputRequestKind(shell);
  return kind === null ? null : `${shell.latestTurn?.turnId ?? ""}:${kind}`;
}

function inputRequestKind(shell: EnvironmentThreadShell): InputRequestKind | null {
  if (shell.archivedAt !== null) return null;
  if (shell.hasPendingApprovals) return "approval";
  if (shell.hasPendingUserInput) return "input";
  return null;
}

/**
 * Threads that entered a pending approval/input state between two shell
 * lists. Threads absent from the previous list never fire: initial sync,
 * environment reconnect, and replayed history arrive already-blocked and must
 * stay silent. A request that merely changes kind (input after approval)
 * counts as a new transition; an unchanged key does not.
 */
export function collectInputRequestCandidates(
  previousShells: ReadonlyArray<EnvironmentThreadShell>,
  nextShells: ReadonlyArray<EnvironmentThreadShell>,
): InputRequestCandidate[] {
  const previousKeys = new Map(
    previousShells.map(
      (shell) =>
        [
          threadKey({ environmentId: shell.environmentId, threadId: shell.id }),
          inputRequestKey(shell),
        ] as const,
    ),
  );
  const candidates: InputRequestCandidate[] = [];
  for (const shell of nextShells) {
    const key = threadKey({ environmentId: shell.environmentId, threadId: shell.id });
    if (!previousKeys.has(key)) continue;
    const kind = inputRequestKind(shell);
    if (kind === null || previousKeys.get(key) === inputRequestKey(shell)) continue;
    candidates.push({
      environmentId: shell.environmentId,
      threadId: shell.id,
      kind,
      title: shell.title,
    });
  }
  return candidates;
}

export function buildInputRequestCopy(candidate: Pick<InputRequestCandidate, "kind" | "title">): {
  title: string;
  body: string;
} {
  const threadLabel = candidate.title.trim();
  return {
    title: candidate.kind === "approval" ? "Approval needed" : "Input needed",
    body:
      threadLabel.length > 0
        ? threadLabel
        : candidate.kind === "approval"
          ? "A thread is waiting for approval."
          : "A thread is waiting for input.",
  };
}
