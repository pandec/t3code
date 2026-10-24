import { PinIcon } from "lucide-react";
import { use } from "react";

import { cn } from "~/lib/utils";
import { useIsMessagePinned, usePinnedMessageStore } from "~/pinnedMessageStore";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { TimelineRowCtx } from "./timelineRowContext";

/** Pins a message's strip on the timeline minimap; only offered where the message has a strip. */
export function MessagePinButton({ messageId }: { messageId: string }) {
  const { routeThreadKey } = use(TimelineRowCtx);
  const pinned = useIsMessagePinned(routeThreadKey, messageId);
  const togglePinnedMessage = usePinnedMessageStore((state) => state.togglePinnedMessage);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-label="Pin message"
            aria-pressed={pinned}
            onClick={() => togglePinnedMessage(routeThreadKey, messageId)}
          />
        }
      >
        <PinIcon className={cn("size-3", pinned && "fill-current text-warning-foreground")} />
      </TooltipTrigger>
      <TooltipPopup side="top">{pinned ? "Unpin message" : "Pin message"}</TooltipPopup>
    </Tooltip>
  );
}
