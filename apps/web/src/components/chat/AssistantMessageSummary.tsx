import {
  beginMessageArtifactRequest,
  getMessageArtifactSessionSnapshot,
  rememberMessageSummary,
  subscribeMessageArtifactSession,
} from "@t3tools/client-runtime/state/messageArtifacts";
import { currentThreadMessageSummary } from "@t3tools/client-runtime/state/voice";
import type { EnvironmentId, MessageId, MessageSummaryResult, ThreadId } from "@t3tools/contracts";
import { FileTextIcon } from "lucide-react";
import { type ReactNode, useCallback, useMemo, useState, useSyncExternalStore } from "react";

import { summarizeMessage } from "../../state/messageArtifacts";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { messageSpeechThread } from "../../state/voice";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface AssistantMessageSummaryState {
  readonly visible: boolean;
  readonly summary: MessageSummaryResult | null;
  readonly expanded: boolean;
  readonly preparing: boolean;
  readonly toggle: () => void;
}

/**
 * On-demand summary of a finished assistant message. Stored summaries come
 * with the thread's listening state, so they show after a reload without
 * asking again (and to read-only clients); this client's own request only
 * adds its result.
 */
export function useAssistantMessageSummary(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly messageId: MessageId;
  readonly text: string;
  readonly streaming: boolean;
  readonly available: boolean;
  /** The environment streams its listening state, stored summaries included. */
  readonly persistentJobs: boolean;
}): AssistantMessageSummaryState {
  const { environmentId, messageId, text, threadId } = input;
  const summarize = useAtomCommand(summarizeMessage, { reportFailure: false });
  const threadState = useEnvironmentQuery(
    input.persistentJobs && threadId !== null
      ? messageSpeechThread({ environmentId, input: { threadId } })
      : null,
  ).data;
  const [preparing, setPreparing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const readSession = useCallback(
    () => getMessageArtifactSessionSnapshot(environmentId, messageId, text),
    [environmentId, messageId, text],
  );
  const session = useSyncExternalStore(
    useCallback(
      (listener) => subscribeMessageArtifactSession(environmentId, messageId, listener),
      [environmentId, messageId],
    ),
    readSession,
    readSession,
  );
  const storedSummary = useMemo(
    () => currentThreadMessageSummary(threadState, messageId, text),
    [threadState, messageId, text],
  );
  const summary = session.summary ?? storedSummary;

  const toggle = useCallback(() => {
    if (summary !== null) {
      setExpanded((current) => !current);
      return;
    }
    if (preparing) return;
    setPreparing(true);
    const endRequest = beginMessageArtifactRequest(environmentId, messageId);
    void summarize({ environmentId, input: { messageId } })
      .then((result) => {
        if (result._tag === "Success") {
          rememberMessageSummary(environmentId, text, result.value);
          setExpanded(true);
          return;
        }
        toastManager.add({
          type: "error",
          title: "Summary unavailable",
          description: "T3 Code could not summarize this message. Try again in a moment.",
        });
      })
      .finally(() => {
        setPreparing(false);
        endRequest();
      });
  }, [environmentId, messageId, preparing, summarize, summary, text]);

  return {
    visible: (summary !== null || input.available) && !input.streaming && text.trim().length > 0,
    summary,
    expanded: summary !== null && expanded,
    preparing,
    toggle,
  };
}

export function AssistantMessageSummaryButton({ state }: { state: AssistantMessageSummaryState }) {
  if (!state.visible) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={state.summary === null ? "Create summary" : "Toggle summary"}
            aria-expanded={state.summary === null ? undefined : state.expanded}
            aria-busy={state.preparing}
            disabled={state.preparing}
            onClick={state.toggle}
          />
        }
      >
        {state.preparing ? (
          <Spinner size="sm" aria-hidden />
        ) : (
          <FileTextIcon className="size-3.5" />
        )}
      </TooltipTrigger>
      <TooltipPopup>
        {state.preparing
          ? "Preparing summary"
          : state.summary === null
            ? "Summarize this response"
            : state.expanded
              ? "Hide summary"
              : "Show summary"}
      </TooltipPopup>
    </Tooltip>
  );
}

export function AssistantMessageSummaryPanel({ children }: { children: ReactNode }) {
  return (
    <div className="mt-2 rounded-xl border border-border/70 bg-secondary/35 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-foreground">
        <FileTextIcon className="size-3.5 text-muted-foreground" />
        <span>Summary</span>
      </div>
      {children}
    </div>
  );
}
