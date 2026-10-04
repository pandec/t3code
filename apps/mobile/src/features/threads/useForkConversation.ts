import { useNavigation } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { conversationForkRunId } from "@t3tools/client-runtime/state/thread-fork";
import { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Haptics from "expo-haptics";
import { useCallback } from "react";
import { Alert } from "react-native";

import { uuidv4 } from "../../lib/uuid";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { waitForThreadShellReady } from "./threadForkNavigation";

// One fork per source thread at a time across every surface (row swipe, row
// menu, thread header), so a double tap cannot create two copies.
const forkInFlightThreadKeys = new Set<string>();

/** Forks a whole conversation into a new thread and opens it. */
export function useForkConversation(): (thread: EnvironmentThreadShell) => void {
  const forkFromRun = useAtomCommand(threadEnvironment.forkFromRun, { reportFailure: false });
  const navigation = useNavigation();

  return useCallback(
    (thread: EnvironmentThreadShell) => {
      const key = scopedThreadKey(thread.environmentId, thread.id);
      if (forkInFlightThreadKeys.has(key)) return;
      const runId = conversationForkRunId(thread);
      if (runId === null) {
        Alert.alert(
          "Could not fork conversation",
          "This conversation cannot be forked right now. Wait for its turn to finish.",
        );
        return;
      }
      forkInFlightThreadKeys.add(key);
      void Haptics.selectionAsync();
      const targetThreadId = ThreadId.make(uuidv4());
      void (async () => {
        try {
          const result = await forkFromRun({
            environmentId: thread.environmentId,
            input: {
              sourceThreadId: thread.id,
              targetThreadId,
              runId,
              creationSource: "mobile",
            },
          });
          if (result._tag === "Failure") {
            const error = Cause.squash(result.cause);
            Alert.alert(
              "Could not fork conversation",
              error instanceof Error && error.message.trim().length > 0
                ? error.message
                : "The fork could not be created.",
            );
            return;
          }
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
          navigation.navigate("Thread", {
            environmentId: thread.environmentId,
            threadId: targetThreadId,
          });
        } finally {
          forkInFlightThreadKeys.delete(key);
        }
      })();
    },
    [forkFromRun, navigation],
  );
}
