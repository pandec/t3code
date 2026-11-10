import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ModelSelection,
  type ThreadId,
} from "@t3tools/contracts";

import { scopedThreadKey } from "../lib/scopedEntities";
import * as Dialog from "../components/ui/Dialog";
import { appAtomRegistry } from "./atom-registry";
import { readEnvironmentScope } from "./session";
import { threadEnvironment } from "./threads";
import {
  releaseStagedModelSelection,
  stageThreadSettings,
  type ThreadSettings,
} from "./use-thread-staged-settings";

/** Sets an existing thread's pick on the thread, so any next turn runs on it. */
export function selectThreadModel(
  ref: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
  value: ModelSelection,
  thread: ThreadSettings,
): void {
  const threadKey = scopedThreadKey(ref.environmentId, ref.threadId);
  // Its own object, so an older reply for an equal pick cannot release this one.
  const modelSelection = { ...value };
  // Fork: existing-thread content drafts never carry a model; the pick shows through staged settings.
  stageThreadSettings(threadKey, { modelSelection }, thread);
  // Another instance replaces the live session, which may hold an open question; that pick
  // still waits for a sent message.
  if (
    thread.modelSelection.instanceId !== modelSelection.instanceId ||
    !readEnvironmentScope(ref.environmentId, AuthOrchestrationOperateScope)
  ) {
    return;
  }
  void runAtomCommand(
    appAtomRegistry,
    threadEnvironment.setModelSelection,
    { environmentId: ref.environmentId, input: { threadId: ref.threadId, modelSelection } },
    { label: "change model", reportFailure: true, reportDefect: true },
  ).then((result) => {
    // Released on the reply, so a later change from another client shows.
    if (result._tag === "Success") {
      releaseStagedModelSelection(threadKey, modelSelection);
    } else {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        "Could not apply model selection",
        `This model pick was not saved. ${error instanceof Error ? error.message : "Try again."}`,
      );
    }
  });
}
