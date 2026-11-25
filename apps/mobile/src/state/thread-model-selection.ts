import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ModelSelection,
  type ThreadId,
} from "@t3tools/contracts";

import { scopedThreadKey } from "../lib/scopedEntities";
import * as Dialog from "../components/ui/Dialog";
import { msg } from "gt-react-native";
import { m } from "../i18n/messages";
import { appAtomRegistry } from "./atom-registry";
import { activeComposerDraftKey, getQueuedRunEdit, isQueuedRunEditSaving } from "./queued-run-edit";
import { readEnvironmentScope } from "./session";
import { threadEnvironment } from "./threads";
import { updateComposerDraftSettings } from "./use-composer-drafts";
import {
  releaseStagedModelSelection,
  stageThreadSettings,
  type ThreadSettings,
} from "./use-thread-staged-settings";

/** Sets an existing thread's pick on the thread, so any next turn runs on it. */
export function selectThreadModel(
  ref: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly draftKey?: string;
  },
  value: ModelSelection,
  thread: ThreadSettings,
): void {
  const threadKey = scopedThreadKey(ref.environmentId, ref.threadId);
  // Its own object, so an older reply for an equal pick cannot release this one.
  const modelSelection = { ...value };
  const draftKey = activeComposerDraftKey(
    threadKey,
    ref.draftKey ?? threadKey,
    getQueuedRunEdit(threadKey),
  );
  if (draftKey !== threadKey) {
    // A queued edit's pick belongs to that edit's draft; the edit save sends it.
    if (!isQueuedRunEditSaving(threadKey))
      updateComposerDraftSettings(draftKey, { modelSelection });
    return;
  }
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
        m(msg("Could not apply model selection")),
        m(
          msg("This model pick was not saved. {detail}", {
            detail: errorDisplayMessage(error, m) ?? m(msg("Try again.")),
          }),
        ),
      );
    }
  });
}
