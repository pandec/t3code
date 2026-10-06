import { Columns2Icon } from "lucide-react";

import { Button } from "../ui/button";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { openCommandPalette } from "../../commandPaletteBus";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useThreadPaneId } from "./threadPaneContext";
import { THREAD_SPLIT_MEDIA_QUERY, useThreadSplitStore } from "./threadSplitStore";

/**
 * Whether "Open split view" shows: never in the secondary pane, while a split
 * is already open (its controls live on the divider — see SplitPaneControls),
 * or on viewports too narrow for a split. The chat header reads this to
 * reserve the control's slot in the titlebar cluster.
 */
export function useOpenSplitViewControlVisible(): boolean {
  const paneId = useThreadPaneId();
  const splitActive = useThreadSplitStore((state) => state.secondaryRef !== null);
  const isWideEnoughForSplit = useMediaQuery(THREAD_SPLIT_MEDIA_QUERY);
  return paneId !== "secondary" && !splitActive && isWideEnoughForSplit;
}

/**
 * "Open split view", rendered as the leading member of the header's panel
 * toggle cluster with the same toggle styling so it reads as part of it.
 */
export function OpenSplitViewControl() {
  const visible = useOpenSplitViewControlVisible();
  if (!visible) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className="shrink-0 [-webkit-app-region:no-drag]"
            pressed={false}
            onPressedChange={() => openCommandPalette({ open: "open-in-split" })}
            aria-label="Open split view"
            variant="ghost"
            size="sm"
          >
            <Columns2Icon className="size-4" />
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">Open split view</TooltipPopup>
    </Tooltip>
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
      {/* The span, not the button, triggers the tooltip: a disabled button
          receives no pointer events, and its label is exactly the state that
          needs explaining (same pattern as PanelLayoutControls). */}
      <TooltipTrigger render={<span className="flex shrink-0" />}>
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
      </TooltipTrigger>
      <TooltipPopup side={tooltipSide}>{label}</TooltipPopup>
    </Tooltip>
  );
}
