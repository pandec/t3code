import { ArrowLeftRightIcon, Columns2Icon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { openCommandPalette } from "../../commandPaletteBus";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useThreadPaneId } from "./threadPaneContext";
import { THREAD_SPLIT_MEDIA_QUERY, useThreadSplitStore } from "./threadSplitStore";

/**
 * Split-view controls for ChatView's titlebar control cluster. The primary
 * pane offers opening a split; the secondary pane offers switching its thread
 * and closing the split.
 */
export function ThreadPaneControls() {
  const paneId = useThreadPaneId();
  const splitActive = useThreadSplitStore((state) => state.secondaryRef !== null);
  const closeSplit = useThreadSplitStore((state) => state.closeSplit);
  const isWideEnoughForSplit = useMediaQuery(THREAD_SPLIT_MEDIA_QUERY);

  if (!isWideEnoughForSplit) {
    return null;
  }

  if (paneId === "secondary") {
    return (
      <div className="flex h-full shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        <PaneControlButton
          label="Switch split thread"
          onClick={() => openCommandPalette({ open: "open-in-split" })}
        >
          <ArrowLeftRightIcon className="size-4" />
        </PaneControlButton>
        <PaneControlButton label="Close split view" onClick={closeSplit}>
          <XIcon className="size-4" />
        </PaneControlButton>
      </div>
    );
  }

  if (splitActive) {
    return null;
  }

  return (
    <div className="flex h-full shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
      <PaneControlButton
        label="Open split view"
        onClick={() => openCommandPalette({ open: "open-in-split" })}
      >
        <Columns2Icon className="size-4" />
      </PaneControlButton>
    </div>
  );
}

function PaneControlButton({
  children,
  label,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
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
            onClick={onClick}
          >
            {children}
          </Button>
        }
      />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}
