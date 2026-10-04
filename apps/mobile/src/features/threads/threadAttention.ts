import {
  admitNewAttentionKeys,
  hasUnseenWake,
} from "@t3tools/client-runtime/state/thread-attention";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { scopedThreadKey } from "../../lib/scopedEntities";

export { hasUnseenWake };

export interface ThreadAttentionFilterState {
  readonly memberThreadKeys: ReadonlySet<string>;
  readonly knownThreadKeys: ReadonlySet<string>;
  readonly memberPendingTaskKeys: ReadonlySet<string>;
  readonly knownPendingTaskKeys: ReadonlySet<string>;
}

type ThreadAttentionKeyInput = Pick<EnvironmentThreadShell, "environmentId" | "id">;

export function pendingTaskAttentionKey(input: {
  readonly environmentId: string;
  readonly messageId: string;
}): string {
  return `${input.environmentId}:${input.messageId}`;
}

export function admitNewThreadAttentionThreads(
  state: ThreadAttentionFilterState,
  threads: ReadonlyArray<ThreadAttentionKeyInput>,
  pendingTaskKeys: ReadonlyArray<string> = [],
): ThreadAttentionFilterState {
  const threadState = admitNewAttentionKeys(
    { memberKeys: state.memberThreadKeys, knownKeys: state.knownThreadKeys },
    threads.map((thread) => scopedThreadKey(thread.environmentId, thread.id)),
  );
  const pendingTaskState = admitNewAttentionKeys(
    { memberKeys: state.memberPendingTaskKeys, knownKeys: state.knownPendingTaskKeys },
    pendingTaskKeys,
  );

  if (
    threadState.memberKeys === state.memberThreadKeys &&
    threadState.knownKeys === state.knownThreadKeys &&
    pendingTaskState.memberKeys === state.memberPendingTaskKeys &&
    pendingTaskState.knownKeys === state.knownPendingTaskKeys
  ) {
    return state;
  }
  return {
    memberThreadKeys: threadState.memberKeys,
    knownThreadKeys: threadState.knownKeys,
    memberPendingTaskKeys: pendingTaskState.memberKeys,
    knownPendingTaskKeys: pendingTaskState.knownKeys,
  };
}
