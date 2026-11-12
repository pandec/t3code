import {
  resolveTimelineMinimapAriaLabel,
  resolveTimelineMinimapItemIndexFromPointer,
  resolveTimelineMinimapScrollOffset,
  resolveTimelineMinimapSpacing,
  resolveTimelineMinimapStripTop,
  resolveTimelineMinimapTooltipTranslate,
  type TimelineMinimapItem,
} from "./MessagesTimeline.minimap";
import { memo, useRef, useState, type MouseEvent } from "react";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { Button } from "../ui/button";
import {
  resolveTimelineMinimapHeightStyle,
  resolveTimelineMinimapNavigationInteractive,
  TIMELINE_MINIMAP_MIN_ITEMS,
} from "./MessagesTimeline.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { formatDayAwareTimestamp } from "../../timestampFormat";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

// A release outside the window can skip `mouseup`, so the next button-free
// `mousemove` also counts.
function onMouseButtonsReleased(onRelease: () => void): () => void {
  const check = (event: globalThis.MouseEvent) => {
    if (event.buttons !== 0) return;
    stop();
    onRelease();
  };
  const stop = () => {
    window.removeEventListener("mouseup", check);
    window.removeEventListener("mousemove", check);
  };
  window.addEventListener("mouseup", check);
  window.addEventListener("mousemove", check);
  return stop;
}

export const TimelineMinimap = memo(function TimelineMinimap({
  anchorIndex,
  hasPersistentGutter,
  hitStripWidth,
  currentIndex = null,
  atEnd = false,
  items,
  pinnedIds,
  side,
  stripMap,
  testId,
  timestampFormat,
  onWheel,
  onSelect,
}: {
  anchorIndex: number | null;
  hasPersistentGutter: boolean;
  hitStripWidth: number;
  currentIndex?: number | null;
  atEnd?: boolean;
  items: ReadonlyArray<TimelineMinimapItem>;
  pinnedIds: ReadonlyArray<string>;
  side: "left" | "right";
  stripMap: Map<string, HTMLSpanElement>;
  testId: string;
  timestampFormat: TimestampFormat;
  onWheel: (event: WheelEvent) => void;
  onSelect: (item: TimelineMinimapItem) => void;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const pinnedIdSet = new Set(pinnedIds);
  const wheelTargetRef = (node: HTMLDivElement | null) => {
    if (!node) return;
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  };

  const pressedOnStripRef = useRef(false);
  const [passThrough, setPassThrough] = useState(false);
  const [keyboardNavigating, setKeyboardNavigating] = useState(false);
  const [railHeight, setRailHeight] = useState(0);
  const [railRef] = useState(() => (node: HTMLDivElement | null) => {
    if (!node) return;
    return observeResize(node, ([entry]) => {
      if (entry) setRailHeight(entry.contentRect.height);
    });
  });

  const resolvedActiveIndex =
    activeIndex !== null && activeIndex < items.length ? activeIndex : null;
  const activeItem = resolvedActiveIndex === null ? null : (items[resolvedActiveIndex] ?? null);
  const navigationInteractive =
    resolveTimelineMinimapNavigationInteractive(hitStripWidth) && !passThrough;
  const activeTooltipTranslate =
    resolvedActiveIndex === null
      ? "-50%"
      : resolveTimelineMinimapTooltipTranslate(resolvedActiveIndex, items.length);
  const resolvedCurrentIndex =
    currentIndex !== null && currentIndex >= 0 && currentIndex < items.length ? currentIndex : null;
  const spacing = resolveTimelineMinimapSpacing(items.length, railHeight);
  // Pointer hover must not move the rail under the cursor; only keyboard focus leads it.
  const readingScrollOffset = resolveTimelineMinimapScrollOffset({
    anchorIndex,
    itemCount: items.length,
    railHeight,
    spacing,
  });
  const scrollOffset =
    keyboardNavigating && resolvedActiveIndex !== null
      ? resolveTimelineMinimapScrollOffset({
          anchorIndex: resolvedActiveIndex,
          itemCount: items.length,
          railHeight,
          spacing,
        })
      : readingScrollOffset;
  const maxScrollOffset = resolveTimelineMinimapScrollOffset({
    anchorIndex: null,
    itemCount: items.length,
    railHeight,
    spacing,
  });
  const railFadeMask =
    maxScrollOffset > 0
      ? `linear-gradient(to bottom, ${scrollOffset > 0 ? "transparent, black 1rem" : "black"}, ${
          scrollOffset < maxScrollOffset ? "black calc(100% - 1rem), transparent" : "black"
        })`
      : undefined;
  const previousItem =
    resolvedCurrentIndex === null ? null : (items[resolvedCurrentIndex - 1] ?? null);
  const nextItem =
    resolvedCurrentIndex === null || atEnd ? null : (items[resolvedCurrentIndex + 1] ?? null);

  const resolveActiveIndexFromPointer = (
    event: MouseEvent<HTMLElement>,
    offset: number = scrollOffset,
  ) => {
    return resolveTimelineMinimapItemIndexFromPointer({
      itemCount: items.length,
      railTop: event.currentTarget.getBoundingClientRect().top,
      scrollOffset: offset,
      spacing,
      pointerY: event.clientY,
    });
  };

  const moveActiveIndex = (delta: number) => {
    setActiveIndex((current) => {
      const base = current ?? 0;
      return Math.max(0, Math.min(items.length - 1, base + delta));
    });
  };

  if (items.length < TIMELINE_MINIMAP_MIN_ITEMS) {
    return null;
  }

  return (
    <div
      className={cn(
        "group/minimap pointer-events-none absolute inset-y-0 z-40 w-18",
        side === "left" ? "left-0" : "right-0",
        hasPersistentGutter
          ? "opacity-100"
          : "hidden opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100 [@media(pointer:fine)]:block",
      )}
      data-minimap-side={side}
      data-testid={testId}
      data-persistent-gutter={hasPersistentGutter ? "true" : "false"}
      ref={wheelTargetRef}
    >
      <div className="relative h-full w-full select-none">
        <div
          className={cn(
            "absolute top-1/2 -translate-y-1/2",
            side === "left" ? "left-3" : "right-3",
            hitStripWidth > 0 && !passThrough ? "pointer-events-auto" : "pointer-events-none",
          )}
          onMouseDown={() => {
            if (pressedOnStripRef.current) return;
            pressedOnStripRef.current = true;
            onMouseButtonsReleased(() => {
              pressedOnStripRef.current = false;
            });
          }}
          onMouseMove={(event) => {
            if (event.buttons === 0 || pressedOnStripRef.current || passThrough) return;
            setPassThrough(true);
            onMouseButtonsReleased(() => setPassThrough(false));
          }}
          ref={railRef}
          style={{
            height: resolveTimelineMinimapHeightStyle(items.length),
            maxHeight: "100%",
            width: hitStripWidth,
          }}
        >
          {side === "left" ? (
            <TimelineMinimapNavigationButton
              direction="previous"
              disabled={previousItem === null}
              interactive={navigationInteractive}
              onClick={() => {
                if (previousItem) onSelect(previousItem);
              }}
            />
          ) : null}
          <button
            aria-label={resolveTimelineMinimapAriaLabel({
              activeIndex: resolvedActiveIndex,
              itemCount: items.length,
              primaryText: activeItem?.primaryText ?? null,
              side,
            })}
            className="absolute inset-y-0 left-0 w-full cursor-pointer bg-transparent before:absolute before:inset-x-0 before:-inset-y-1 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
            onBlur={() => {
              setActiveIndex(null);
              setKeyboardNavigating(false);
            }}
            onClick={(event) => {
              const nextIndex = resolveActiveIndexFromPointer(event);
              const selectedItem = nextIndex === null ? null : (items[nextIndex] ?? null);
              if (selectedItem) {
                onSelect(selectedItem);
              }
              event.currentTarget.blur();
            }}
            onFocus={() =>
              setActiveIndex((current) => current ?? resolvedCurrentIndex ?? anchorIndex ?? 0)
            }
            onKeyDown={(event) => {
              if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                setKeyboardNavigating(true);
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveActiveIndex(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveActiveIndex(-1);
              } else if (event.key === "Home") {
                event.preventDefault();
                setActiveIndex(0);
              } else if (event.key === "End") {
                event.preventDefault();
                setActiveIndex(items.length - 1);
              } else if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                if (activeItem) {
                  onSelect(activeItem);
                }
              }
            }}
            onMouseLeave={() => setActiveIndex(null)}
            onMouseMove={(event) => {
              if (event.buttons !== 0 && !pressedOnStripRef.current) return;
              // The pointer ends keyboard leading, so hit-test against the reading offset it restores.
              setKeyboardNavigating(false);
              setActiveIndex(resolveActiveIndexFromPointer(event, readingScrollOffset));
            }}
            onMouseDown={(event) => event.preventDefault()}
            type="button"
          >
            <div
              className="absolute -inset-y-1 inset-x-0 overflow-y-clip"
              style={{ maskImage: railFadeMask }}
            >
              <div
                className={cn(
                  "absolute inset-y-1 w-px bg-border/15",
                  side === "left" ? "left-3" : "right-3",
                )}
              />
              <div
                className="absolute inset-x-0 top-1"
                style={{ transform: `translateY(${-scrollOffset}px)` }}
              >
                {items.map((item, index) => {
                  const activeDistance =
                    resolvedActiveIndex === null ? null : Math.abs(index - resolvedActiveIndex);
                  const pinned = pinnedIdSet.has(item.id);
                  return (
                    // Compositor-friendly on purpose: in-view state and the hover
                    // fisheye animate constantly (every scroll tick and streaming
                    // update flips a band of strips), so the strip animates only
                    // transform and opacity.
                    <span
                      aria-hidden="true"
                      className={cn(
                        "pointer-events-none absolute h-0.5 w-6 -translate-y-1/2 rounded-full transition-transform duration-150 after:absolute after:inset-0 after:rounded-full after:opacity-0 after:transition-opacity after:duration-150 data-[in-view=true]:after:opacity-100",
                        side === "left" ? "left-0 origin-left" : "right-0 origin-right",
                        pinned
                          ? activeDistance === 0
                            ? "bg-warning-foreground"
                            : "bg-warning-foreground/60"
                          : item.fromAgent
                            ? activeDistance === 0
                              ? "bg-info-foreground"
                              : "bg-info-foreground/45"
                            : activeDistance === 0
                              ? "bg-muted-foreground/60"
                              : "bg-muted-foreground/25",
                        pinned
                          ? "after:bg-warning-foreground"
                          : item.fromAgent
                            ? "after:bg-info-foreground"
                            : "after:bg-foreground/55",
                        activeDistance === 0
                          ? "scale-x-100"
                          : activeDistance === 1
                            ? "scale-x-[0.667]"
                            : activeDistance === 2
                              ? "scale-x-[0.417]"
                              : "scale-x-[0.333]",
                      )}
                      data-in-view="false"
                      data-minimap-strip
                      key={item.id}
                      ref={(node) => {
                        if (node) {
                          stripMap.set(item.id, node);
                        } else {
                          stripMap.delete(item.id);
                        }
                      }}
                      style={{ top: resolveTimelineMinimapStripTop(index, spacing) }}
                    />
                  );
                })}
              </div>
            </div>
            {activeItem ? (
              // Display-only: it overlaps the message column, and the strip keeps tracking beneath it.
              <span
                className={cn(
                  "pointer-events-none absolute w-80",
                  side === "left" ? "left-8" : "right-8",
                )}
                style={{
                  top:
                    resolveTimelineMinimapStripTop(resolvedActiveIndex ?? 0, spacing) -
                    scrollOffset,
                  transform: `translateY(${activeTooltipTranslate})`,
                }}
              >
                <span className="dropdown-glass block rounded-xl p-3 text-left text-popover-foreground shadow-xl shadow-black/25">
                  <span className="mb-1 block text-muted-foreground text-xs leading-4">
                    {activeItem.fromAgent ? "From an agent · " : null}
                    {formatDayAwareTimestamp(activeItem.timestamp, timestampFormat)}
                  </span>
                  <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium leading-5">
                    {activeItem.primaryText ??
                      (side === "left" ? "User message" : "Agent response")}
                  </span>
                  {activeItem.secondaryText ? (
                    <span
                      className="mt-1 max-h-[3.75rem] overflow-hidden text-muted-foreground text-sm leading-5"
                      style={{
                        display: "-webkit-box",
                        WebkitBoxOrient: "vertical",
                        WebkitLineClamp: 3,
                      }}
                    >
                      {activeItem.secondaryText}
                    </span>
                  ) : null}
                </span>
              </span>
            ) : null}
          </button>
          {side === "left" ? (
            <TimelineMinimapNavigationButton
              direction="next"
              disabled={nextItem === null}
              interactive={navigationInteractive}
              onClick={() => {
                if (nextItem) onSelect(nextItem);
              }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
});

function TimelineMinimapNavigationButton({
  direction,
  disabled,
  interactive,
  onClick,
}: {
  direction: "previous" | "next";
  disabled: boolean;
  interactive: boolean;
  onClick: () => void;
}) {
  const previous = direction === "previous";
  const label = previous ? "Previous turn" : "Next turn";
  const Icon = previous ? ChevronUpIcon : ChevronDownIcon;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "absolute left-1 z-10 inline-flex -translate-x-1/2 opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100",
              interactive ? "pointer-events-auto" : "pointer-events-none",
              previous ? "bottom-[calc(100%+6px)]" : "top-[calc(100%+6px)]",
            )}
          />
        }
      >
        <Button
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          size="icon-micro"
          type="button"
          variant="ghost-muted"
        >
          <Icon className="size-4 text-foreground/90" />
        </Button>
      </TooltipTrigger>
      <TooltipPopup side={previous ? "top" : "bottom"}>{label}</TooltipPopup>
    </Tooltip>
  );
}
