import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

export const TIMELINE_MINIMAP_ITEM_SPACING = 8;
export const TIMELINE_MINIMAP_MIN_ITEMS = 2;
export const TIMELINE_MINIMAP_MAX_HEIGHT_CSS = "calc(100vh - 18rem)";
export const TIMELINE_CONTENT_MAX_WIDTH = 768;
export const TIMELINE_MINIMAP_PERSISTENT_GUTTER = 48;
export const TIMELINE_MINIMAP_ARIA_EXCERPT_MAX_LENGTH = 120;
export const TIMELINE_MINIMAP_HIT_STRIP_LEFT = 12;
export const TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH = 40;
export const TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH = "22rem";

export type TimelineMinimapKind = "user-turn" | "final-assistant";

export interface TimelineMinimapItem {
  readonly id: string;
  readonly rowIndex: number;
  readonly positionIndex: number;
  readonly positionCount: number;
  readonly primaryText: string | null;
  readonly secondaryText: string | null;
}

interface TimelineMinimapPreviewCacheEntry {
  readonly contentVersion: string | null | undefined;
  readonly compactText: string | null;
  readonly streaming: boolean;
  readonly endsWithWhitespace: boolean;
}

export interface TimelineMinimapState {
  readonly previewByRowId: ReadonlyMap<string, TimelineMinimapPreviewCacheEntry>;
  readonly userItems: ReadonlyArray<TimelineMinimapItem>;
  readonly assistantItems: ReadonlyArray<TimelineMinimapItem>;
}

export const EMPTY_TIMELINE_MINIMAP_STATE: TimelineMinimapState = {
  previewByRowId: new Map(),
  userItems: [],
  assistantItems: [],
};

type MessageRow = Extract<MessagesTimelineRow, { kind: "message" }>;

function compactMinimapPreview(text: string | null | undefined) {
  const compact = text?.replace(/\s+/g, " ").trim() ?? "";
  return compact.length > 0 ? compact : null;
}

function textEndsWithWhitespace(text: string | null | undefined) {
  if (!text || text.length === 0) {
    return false;
  }
  return /\s/u.test(text.at(-1)!);
}

function appendCompactMinimapPreview(
  cached: TimelineMinimapPreviewCacheEntry,
  contentVersion: string,
): string | null {
  const previousText = cached.contentVersion;
  if (typeof previousText !== "string") {
    return compactMinimapPreview(contentVersion);
  }
  const appendedText = contentVersion.slice(previousText.length);
  const compactAppend = compactMinimapPreview(appendedText);
  if (compactAppend === null) {
    return cached.compactText;
  }
  if (cached.compactText === null) {
    return compactAppend;
  }
  const needsSpace = cached.endsWithWhitespace || /^\s/u.test(appendedText);
  return `${cached.compactText}${needsSpace ? " " : ""}${compactAppend}`;
}

function resolveCachedPreview(
  row: MessageRow,
  previous: TimelineMinimapState,
  nextPreviewByRowId: Map<string, TimelineMinimapPreviewCacheEntry>,
): string | null {
  const contentVersion = row.message.text;
  const streaming = row.message.streaming;
  const cached = nextPreviewByRowId.get(row.id) ?? previous.previewByRowId.get(row.id);
  let next: TimelineMinimapPreviewCacheEntry;
  if (cached?.contentVersion === contentVersion) {
    next = cached.streaming === streaming ? cached : { ...cached, streaming };
  } else {
    // The message projector constructs a stable streaming message by appending
    // each delta, so a longer in-progress version can normalize only its tail.
    const canAppendStreamingTail =
      cached !== undefined &&
      cached.streaming &&
      streaming &&
      typeof cached.contentVersion === "string" &&
      typeof contentVersion === "string" &&
      contentVersion.length >= cached.contentVersion.length;
    next = {
      contentVersion,
      compactText: canAppendStreamingTail
        ? appendCompactMinimapPreview(cached, contentVersion)
        : compactMinimapPreview(contentVersion),
      streaming,
      endsWithWhitespace: textEndsWithWhitespace(contentVersion),
    };
  }
  nextPreviewByRowId.set(row.id, next);
  return next.compactText;
}

function reuseMinimapItem(
  previousById: ReadonlyMap<string, TimelineMinimapItem>,
  item: TimelineMinimapItem,
): TimelineMinimapItem {
  const previous = previousById.get(item.id);
  return previous &&
    previous.rowIndex === item.rowIndex &&
    previous.positionIndex === item.positionIndex &&
    previous.positionCount === item.positionCount &&
    previous.primaryText === item.primaryText &&
    previous.secondaryText === item.secondaryText
    ? previous
    : item;
}

function reuseMinimapItems(
  previous: ReadonlyArray<TimelineMinimapItem>,
  next: TimelineMinimapItem[],
): ReadonlyArray<TimelineMinimapItem> {
  return previous.length === next.length && next.every((item, index) => previous[index] === item)
    ? previous
    : next;
}

/**
 * Derives both rails in one shared pass after counting turn positions and
 * reuses compact previews for unchanged message text. Streaming normalizes
 * only the appended response tail; historical previews and the unaffected rail
 * retain their identity.
 */
export function computeTimelineMinimapState(
  rows: ReadonlyArray<MessagesTimelineRow>,
  previous: TimelineMinimapState,
): TimelineMinimapState {
  const positionCount = Math.max(
    1,
    rows.reduce(
      (count, row) => count + (row.kind === "message" && row.message.role === "user" ? 1 : 0),
      0,
    ),
  );
  const previousUserById = new Map(previous.userItems.map((item) => [item.id, item]));
  const previousAssistantById = new Map(previous.assistantItems.map((item) => [item.id, item]));
  const nextPreviewByRowId = new Map<string, TimelineMinimapPreviewCacheEntry>();
  const userItems: TimelineMinimapItem[] = [];
  const assistantItems: TimelineMinimapItem[] = [];
  let positionIndex = -1;
  let currentUserRow: MessageRow | null = null;
  let currentUserRowIndex = -1;
  let currentTurnLastAssistantRow: MessageRow | null = null;

  const appendCurrentUserItem = () => {
    if (currentUserRow === null) {
      return;
    }
    userItems.push(
      reuseMinimapItem(previousUserById, {
        id: currentUserRow.id,
        rowIndex: currentUserRowIndex,
        positionIndex: Math.max(0, positionIndex),
        positionCount,
        primaryText: resolveCachedPreview(currentUserRow, previous, nextPreviewByRowId),
        secondaryText:
          currentTurnLastAssistantRow === null
            ? null
            : resolveCachedPreview(currentTurnLastAssistantRow, previous, nextPreviewByRowId),
      }),
    );
  };

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row?.kind !== "message") {
      continue;
    }

    if (row.message.role === "user") {
      appendCurrentUserItem();
      positionIndex += 1;
      currentUserRow = row;
      currentUserRowIndex = rowIndex;
      currentTurnLastAssistantRow = null;
      continue;
    }

    if (row.message.role !== "assistant") {
      continue;
    }

    currentTurnLastAssistantRow = row;
    if (row.isFinalAssistantResponse) {
      assistantItems.push(
        reuseMinimapItem(previousAssistantById, {
          id: row.id,
          rowIndex,
          positionIndex: Math.max(0, positionIndex),
          positionCount,
          primaryText: resolveCachedPreview(row, previous, nextPreviewByRowId),
          secondaryText: null,
        }),
      );
    }
  }
  appendCurrentUserItem();

  return {
    previewByRowId: nextPreviewByRowId,
    userItems: reuseMinimapItems(previous.userItems, userItems),
    assistantItems: reuseMinimapItems(previous.assistantItems, assistantItems),
  };
}

export function deriveTimelineMinimapItems(
  rows: ReadonlyArray<MessagesTimelineRow>,
  kind: TimelineMinimapKind,
): ReadonlyArray<TimelineMinimapItem> {
  const state = computeTimelineMinimapState(rows, EMPTY_TIMELINE_MINIMAP_STATE);
  return kind === "user-turn" ? state.userItems : state.assistantItems;
}

export function resolveTimelineMinimapHeightStyle(itemCount: number): string {
  const naturalHeight = Math.max(1, (itemCount - 1) * TIMELINE_MINIMAP_ITEM_SPACING);
  return `min(${naturalHeight}px, ${TIMELINE_MINIMAP_MAX_HEIGHT_CSS})`;
}

export function resolveTimelineMinimapTopPercent(index: number, itemCount: number): number {
  if (itemCount <= 1) {
    return 0;
  }
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100;
}

export function resolveTimelineMinimapTooltipTranslate(
  positionIndex: number,
  positionCount: number,
): string {
  if (positionIndex === 0) {
    return "0%";
  }
  if (positionIndex === positionCount - 1) {
    return "-100%";
  }
  return "-50%";
}

export function resolveTimelineMinimapIndexFromPointer(input: {
  readonly itemCount: number;
  readonly railTop: number;
  readonly railHeight: number;
  readonly pointerY: number;
}): number | null {
  if (input.itemCount <= 0 || input.railHeight <= 0) {
    return null;
  }
  if (input.itemCount === 1) {
    return 0;
  }

  const progress = Math.max(0, Math.min(1, (input.pointerY - input.railTop) / input.railHeight));
  return Math.max(0, Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))));
}

export function resolveTimelineMinimapItemIndexFromPointer(input: {
  readonly items: ReadonlyArray<Pick<TimelineMinimapItem, "positionCount" | "positionIndex">>;
  readonly railTop: number;
  readonly railHeight: number;
  readonly pointerY: number;
}): number | null {
  const firstItem = input.items[0];
  if (!firstItem || input.railHeight <= 0) {
    return null;
  }
  const progress = Math.max(0, Math.min(1, (input.pointerY - input.railTop) / input.railHeight));
  const targetPosition = progress * Math.max(0, firstItem.positionCount - 1);

  let low = 0;
  let high = input.items.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (input.items[middle]!.positionIndex < targetPosition) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  if (low === 0) {
    return 0;
  }
  if (low === input.items.length) {
    return input.items.length - 1;
  }

  const previousIndex = low - 1;
  const previousDistance = targetPosition - input.items[previousIndex]!.positionIndex;
  const nextDistance = input.items[low]!.positionIndex - targetPosition;
  return previousDistance <= nextDistance ? previousIndex : low;
}

export function resolveTimelineMinimapHasPersistentGutter(viewportWidth: number): boolean {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return false;
  }

  const contentWidth = Math.min(viewportWidth, TIMELINE_CONTENT_MAX_WIDTH);
  const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2);
  return sideGutter >= TIMELINE_MINIMAP_PERSISTENT_GUTTER;
}

/**
 * The minimap overlays the viewport's left edge while the content column is
 * centered, so the side gutter between them shrinks under browser zoom or a
 * narrow pane. A fixed-width hover strip would then sit on top of the message
 * text and swallow its pointer events. Cap the strip's width so it never
 * extends past the gutter into the content column; 0 disables the strip.
 */
export function resolveTimelineMinimapHitStripWidth(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return 0;
  }

  const contentWidth = Math.min(viewportWidth, TIMELINE_CONTENT_MAX_WIDTH);
  const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2);
  return Math.max(
    0,
    Math.min(
      TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH,
      Math.floor(sideGutter) - TIMELINE_MINIMAP_HIT_STRIP_LEFT,
    ),
  );
}

/**
 * Once the preview is open, keep the full preview and the space leading to it
 * interactive. The collapsed strip remains gutter-capped so it cannot block
 * selecting message text.
 */
export function resolveTimelineMinimapInteractiveWidth(
  collapsedWidth: number,
  expanded: boolean,
): number | string {
  return expanded ? TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH : collapsedWidth;
}

export function resolveTimelineMinimapAriaLabel(input: {
  readonly activeIndex: number | null;
  readonly itemCount: number;
  readonly primaryText: string | null;
  readonly side: "left" | "right";
}): string {
  const fallback = input.side === "left" ? "User message" : "Agent response";
  if (input.activeIndex === null) {
    return `Jump to message: ${fallback}`;
  }

  const role = input.side === "left" ? "user message" : "agent response";
  const position = `${input.activeIndex + 1} of ${input.itemCount}`;
  const excerpt = input.primaryText?.slice(0, TIMELINE_MINIMAP_ARIA_EXCERPT_MAX_LENGTH) ?? null;
  return excerpt ? `Jump to ${role} ${position}: ${excerpt}` : `Jump to ${role} ${position}`;
}

export interface TimelineMinimapPositionState {
  readonly positionAtIndex?: (index: number) => number | undefined;
  readonly sizeAtIndex?: (index: number) => number | undefined;
}

function resolveTimelineRowTop(state: TimelineMinimapPositionState, rowIndex: number) {
  const top = state.positionAtIndex?.(rowIndex);
  return typeof top === "number" && Number.isFinite(top) ? top : null;
}

function resolveTimelineRowHeight(state: TimelineMinimapPositionState, rowIndex: number) {
  const height = state.sizeAtIndex?.(rowIndex);
  return typeof height === "number" && Number.isFinite(height) ? height : null;
}

function resolveVisibleItemIdsByScan(input: {
  readonly items: ReadonlyArray<TimelineMinimapItem>;
  readonly state: TimelineMinimapPositionState;
  readonly scrollTop: number;
  readonly scrollBottom: number;
}): string[] {
  const visibleIds: string[] = [];
  for (const item of input.items) {
    const rowTop = resolveTimelineRowTop(input.state, item.rowIndex);
    const rowHeight = resolveTimelineRowHeight(input.state, item.rowIndex);
    if (
      rowTop !== null &&
      rowTop < input.scrollBottom &&
      rowTop + Math.max(1, rowHeight ?? 1) > input.scrollTop
    ) {
      visibleIds.push(item.id);
    }
  }
  return visibleIds;
}

/** Finds visible markers in O(log n + visible markers), with a scan fallback for incomplete layouts. */
export function resolveTimelineMinimapVisibleItemIds(input: {
  readonly items: ReadonlyArray<TimelineMinimapItem>;
  readonly state: TimelineMinimapPositionState;
  readonly scrollTop: number;
  readonly scrollBottom: number;
}): ReadonlyArray<string> {
  if (input.items.length === 0 || input.state.positionAtIndex === undefined) {
    return [];
  }

  let low = 0;
  let high = input.items.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const rowTop = resolveTimelineRowTop(input.state, input.items[middle]!.rowIndex);
    if (rowTop === null) {
      return resolveVisibleItemIdsByScan(input);
    }
    if (rowTop < input.scrollTop) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  const visibleIds: string[] = [];
  const precedingIndex = low - 1;
  if (precedingIndex >= 0) {
    const precedingItem = input.items[precedingIndex]!;
    const rowTop = resolveTimelineRowTop(input.state, precedingItem.rowIndex);
    const rowHeight = resolveTimelineRowHeight(input.state, precedingItem.rowIndex);
    if (
      rowTop === null ||
      (rowTop < input.scrollBottom && rowTop + Math.max(1, rowHeight ?? 1) > input.scrollTop)
    ) {
      if (rowTop === null) {
        return resolveVisibleItemIdsByScan(input);
      }
      visibleIds.push(precedingItem.id);
    }
  }

  for (let index = low; index < input.items.length; index += 1) {
    const item = input.items[index]!;
    const rowTop = resolveTimelineRowTop(input.state, item.rowIndex);
    if (rowTop === null) {
      return resolveVisibleItemIdsByScan(input);
    }
    if (rowTop >= input.scrollBottom) {
      break;
    }
    visibleIds.push(item.id);
  }
  return visibleIds;
}
