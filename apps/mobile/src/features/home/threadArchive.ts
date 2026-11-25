import {
  threadRuntimeCanArchive,
  type ThreadRuntimeSummary,
} from "@t3tools/client-runtime/state/models";

import type { ArchiveQueuedMessageDiscard } from "@t3tools/client-runtime/state/thread-settled";

import * as Dialog from "../../components/ui/Dialog";

export function threadCanArchive(runtime: ThreadRuntimeSummary | null | undefined): boolean {
  return threadRuntimeCanArchive(runtime);
}

/** Fork: asks before an archive discards queued messages of a thread or its side chats. */
export function confirmQueuedMessageDiscard(input: {
  readonly title: string;
  readonly discarded: ArchiveQueuedMessageDiscard;
  readonly whenDone: boolean;
  readonly onConfirm: () => void;
}): void {
  const { total, inSideChats } = input.discarded;
  const waiting =
    inSideChats === 0
      ? `“${input.title}” has`
      : inSideChats === total
        ? `Side chats of “${input.title}” have`
        : `“${input.title}” and its side chats have`;
  Dialog.confirm({
    title: `Archive${input.whenDone ? " when done" : ""} and discard ${total} queued ${total === 1 ? "message" : "messages"}?`,
    message: `${waiting} messages waiting to run. Archiving discards them.${
      inSideChats === 0
        ? ""
        : " A side chat still running a delegated task stays open and keeps its messages."
    }`,
    confirmText: "Archive",
    destructive: true,
    onConfirm: input.onConfirm,
  });
}
