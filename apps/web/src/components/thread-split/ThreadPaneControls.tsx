import { Columns2Icon } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { openCommandPalette } from "../../commandPaletteBus";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useThreadPaneId } from "./threadPaneContext";
import { THREAD_SPLIT_MEDIA_QUERY, useThreadSplitStore } from "./threadSplitStore";

/**
 * "Open split view" for the chat header's action row. Fully self-gated so
 * the ChatHeader seam stays a bare render: nothing shows in the secondary
 * pane, while a split is already open (its controls live on the divider —
 * see SplitPaneControls), or on viewports too narrow for a split.
 */
export function OpenSplitViewControl() {
  const paneId = useThreadPaneId();
  const splitActive = useThreadSplitStore((state) => state.secondaryRef !== null);
  const isWideEnoughForSplit = useMediaQuery(THREAD_SPLIT_MEDIA_QUERY);

  if (paneId === "secondary" || splitActive || !isWideEnoughForSplit) {
    return null;
  }

  return (
    <PaneControlButton
      label="Open split view"
      onClick={() => openCommandPalette({ open: "open-in-split" })}
    >
      <Columns2Icon className="size-4" />
    </PaneControlButton>
  );
}

export function PaneControlButton({
  children,
  label,
  onClick,
  disabled = false,
  tooltipSide = "bottom",
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tooltipSide?: "top" | "bottom" | "left" | "right";
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            className="shrink-0 [-webkit-app-region:no-drag]"
            aria-label={label}
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={onClick}
          >
            {children}
          </Button>
        }
      />
      <TooltipPopup side={tooltipSide}>{label}</TooltipPopup>
    </Tooltip>
  );
}
