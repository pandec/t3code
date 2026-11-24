import {
  threadRuntimeCanArchive,
  type ThreadRuntimeSummary,
} from "@t3tools/client-runtime/state/models";

import * as Dialog from "../../components/ui/Dialog";

export function threadCanArchive(runtime: ThreadRuntimeSummary | null | undefined): boolean {
  return threadRuntimeCanArchive(runtime);
}

/** Fork: asks before archiving now discards a thread's queued messages. */
export function confirmQueuedMessageDiscard(input: {
  readonly title: string;
  readonly count: number;
  readonly onConfirm: () => void;
  readonly onCancel?: () => void;
}): void {
  Dialog.confirm({
    title: `Archive and discard ${input.count} queued ${input.count === 1 ? "message" : "messages"}?`,
    message: `“${input.title}” has messages waiting to run. Archiving discards them.`,
    confirmText: "Archive",
    destructive: true,
    onConfirm: input.onConfirm,
    ...(input.onCancel === undefined ? {} : { onCancel: input.onCancel }),
  });
}
