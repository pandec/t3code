import { useNavigation } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { conversationForkTarget } from "@t3tools/client-runtime/state/thread-fork";
import { AuthOrchestrationOperateScope, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Haptics from "expo-haptics";
import { useCallback } from "react";
import { Alert } from "react-native";

import { uuidv4 } from "../../lib/uuid";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { appAtomRegistry } from "../../state/atom-registry";
import { readCanForkImportedSession } from "../../state/entities";
import { readEnvironmentScope } from "../../state/session";
import { sessionImportEnvironment } from "../../state/sessionImport";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { waitForThreadShellReady } from "./threadForkNavigation";

// One fork per source thread at a time across every surface (row swipe, row
// menu, thread header), so a double tap cannot create two copies.
const forkInFlightThreadKeys = new Set<string>();

/**
 * Forks a whole conversation into a new thread and opens it. `openThread`
 * opens the fork where the root stack is unreachable (the iPad sidebar's
 * independent navigator); otherwise the fork is pushed on the root stack.
 */
export function useForkConversation(
  openThread?: (thread: EnvironmentThreadShell) => void,
): (thread: EnvironmentThreadShell) => void {
  const forkFromRun = useAtomCommand(threadEnvironment.forkFromRun, { reportFailure: false });
  const forkImportedThread = useAtomCommand(sessionImportEnvironment.forkThread, {
    reportFailure: false,
  });
  const navigation = useNavigation();

  return useCallback(
    (thread: EnvironmentThreadShell) => {
      const key = scopedThreadKey(thread.environmentId, thread.id);
      if (forkInFlightThreadKeys.has(key)) return;
      if (!readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) {
        Alert.alert("Could not fork conversation", "This connection cannot change threads.");
        return;
      }
      const forkTarget = conversationForkTarget(thread, {
        canForkImportedSession: readCanForkImportedSession(thread),
      });
      if (forkTarget === null) {
        Alert.alert(
          "Could not fork conversation",
          "This conversation cannot be forked right now. Wait for its turn to finish.",
        );
        return;
      }
      forkInFlightThreadKeys.add(key);
      void Haptics.selectionAsync();
      void (async () => {
        try {
          // A runless imported thread forks its native session server-side.
          const forked: { readonly threadId: ThreadId } | Cause.Cause<unknown> =
            forkTarget.type === "run"
              ? await (async () => {
                  const threadId = ThreadId.make(uuidv4());
                  const result = await forkFromRun({
                    environmentId: thread.environmentId,
                    input: {
                      sourceThreadId: thread.id,
                      targetThreadId: threadId,
                      runId: forkTarget.runId,
                      creationSource: "mobile",
                    },
                  });
                  return result._tag === "Failure" ? result.cause : { threadId };
                })()
              : await forkImportedThread({
                  environmentId: thread.environmentId,
                  input: { threadId: thread.id },
                }).then((result) => (result._tag === "Failure" ? result.cause : result.value));
          if (Cause.isCause(forked)) {
            const error = Cause.squash(forked);
            Alert.alert(
              "Could not fork conversation",
              error instanceof Error && error.message.trim().length > 0
                ? error.message
                : "The fork could not be created.",
            );
            return;
          }
          const targetThreadId = forked.threadId;
          const targetShell = environmentThreadShells.threadShellAtom(
            scopeThreadRef(thread.environmentId, targetThreadId),
          );
          const ready = await waitForThreadShellReady({
            read: () => appAtomRegistry.get(targetShell) !== null,
          });
          if (!ready) {
            Alert.alert(
              "Fork created",
              "Its thread data did not reach this client. Reconnect and try opening it from the thread list.",
            );
            return;
          }
          const shell = appAtomRegistry.get(targetShell);
          if (openThread !== undefined && shell !== null) {
            openThread(shell);
            return;
          }
          navigation.navigate("Thread", {
            environmentId: thread.environmentId,
            threadId: targetThreadId,
          });
        } finally {
          forkInFlightThreadKeys.delete(key);
        }
      })();
    },
    [forkFromRun, forkImportedThread, navigation, openThread],
  );
}
