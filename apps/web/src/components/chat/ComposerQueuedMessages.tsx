import {
  queuedThreadMessageIntent,
  queuedThreadMessagePreview,
  type QueuedThreadMessage,
} from "@t3tools/client-runtime/state/thread-outbox-model";
import type { MessageId } from "@t3tools/contracts";
import { ArrowUpIcon, LoaderIcon, PencilIcon, Trash2Icon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ComposerQueuedMessagesProps {
  messages: ReadonlyArray<QueuedThreadMessage>;
  dispatchingMessageId: MessageId | null;
  onSteerNow: (message: QueuedThreadMessage) => void;
  onEdit: (message: QueuedThreadMessage) => void;
  onDelete: (message: QueuedThreadMessage) => void;
  className?: string;
}

/**
 * Messages queued for the active thread while its turn runs, rendered above
 * the composer. Each row can be steered into the running turn, loaded back
 * into the composer for editing, or deleted — except while the drain is
 * delivering that row.
 */
export function ComposerQueuedMessages({
  messages,
  dispatchingMessageId,
  onSteerNow,
  onEdit,
  onDelete,
  className,
}: ComposerQueuedMessagesProps) {
  if (messages.length === 0) return null;

  return (
    <div className={cn("mx-auto w-full max-w-3xl px-1 pb-1.5", className)}>
      <div className="text-[11px] font-medium tracking-wide text-muted-foreground/80 uppercase">
        {messages.length === 1 ? "1 queued" : `${messages.length} queued`}
      </div>
      <ul className="mt-0.5 max-h-56 overflow-y-auto">
        {messages.map((message) => {
          const isDispatching = dispatchingMessageId === message.messageId;
          const canSteer = queuedThreadMessageIntent(message) === "queue" && !isDispatching;
          return (
            <li key={message.messageId} className="group flex min-w-0 items-center gap-1.5 py-0.5">
              <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
                {queuedThreadMessagePreview(message)}
              </span>
              <span className="flex shrink-0 items-center gap-0.5">
                {isDispatching ? (
                  <span
                    className="flex size-6 items-center justify-center text-muted-foreground"
                    aria-label="Sending queued message"
                  >
                    <LoaderIcon className="size-3.5 animate-spin" aria-hidden />
                  </span>
                ) : (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          className="size-6 rounded-full text-muted-foreground hover:text-foreground"
                          aria-label="Send into the running turn now"
                          disabled={!canSteer}
                          onClick={() => onSteerNow(message)}
                        >
                          <ArrowUpIcon className="size-3.5" aria-hidden />
                        </Button>
                      }
                    />
                    <TooltipPopup side="top">Send into the running turn now</TooltipPopup>
                  </Tooltip>
                )}
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="size-6 rounded-full text-muted-foreground hover:text-foreground"
                        aria-label="Edit queued message"
                        disabled={dispatchingMessageId === message.messageId}
                        onClick={() => onEdit(message)}
                      >
                        <PencilIcon className="size-3.5" aria-hidden />
                      </Button>
                    }
                  />
                  <TooltipPopup side="top">Edit in composer</TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="size-6 rounded-full text-muted-foreground hover:text-destructive"
                        aria-label="Delete queued message"
                        disabled={dispatchingMessageId === message.messageId}
                        onClick={() => onDelete(message)}
                      >
                        <Trash2Icon className="size-3.5" aria-hidden />
                      </Button>
                    }
                  />
                  <TooltipPopup side="top">Delete</TooltipPopup>
                </Tooltip>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
