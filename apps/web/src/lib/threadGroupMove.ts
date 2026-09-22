import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";

export interface GroupMoveThread {
  readonly id: ThreadId;
  readonly environmentId: EnvironmentId;
}

/** Threads a bulk move can act on: only those whose server accepts group
 * membership. Mixed selections move what they can; the caller labels the
 * action with this count so it never promises more than it will touch. */
export function groupMovableThreads<T extends GroupMoveThread>(
  threads: ReadonlyArray<T>,
  supportsCustomGroups: (environmentId: EnvironmentId) => boolean,
): T[] {
  return threads.filter((thread) => supportsCustomGroups(thread.environmentId));
}

export interface MoveThreadsToGroupOutcome {
  /** Scoped keys of threads whose move succeeded, for dropping them from a selection. */
  readonly movedThreadKeys: string[];
  /** First non-interrupted failure, already squashed to an Error-like value. */
  readonly firstError: unknown;
  readonly failedCount: number;
}

/** Moves each thread independently so one failure never blocks the rest;
 * failed threads stay behind for the caller to keep selected and retry. */
export async function moveThreadsToGroup(input: {
  readonly threads: ReadonlyArray<GroupMoveThread>;
  readonly customGroupId: string | null;
  readonly move: (
    threadRef: ScopedThreadRef,
    customGroupId: string | null,
  ) => Promise<AtomCommandResult<unknown, unknown>>;
}): Promise<MoveThreadsToGroupOutcome> {
  const results = await Promise.all(
    input.threads.map(async (thread) => {
      const threadRef = scopeThreadRef(thread.environmentId, thread.id);
      const result = await input.move(threadRef, input.customGroupId);
      return { threadKey: scopedThreadKey(threadRef), result };
    }),
  );
  const movedThreadKeys = results.flatMap(({ threadKey, result }) =>
    result._tag === "Success" ? [threadKey] : [],
  );
  const failures = results.flatMap(({ result }) =>
    result._tag === "Failure" && !isAtomCommandInterrupted(result)
      ? [squashAtomCommandFailure(result)]
      : [],
  );
  return { movedThreadKeys, firstError: failures[0] ?? null, failedCount: failures.length };
}
