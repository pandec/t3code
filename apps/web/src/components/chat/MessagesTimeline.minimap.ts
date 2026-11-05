import { isAttachmentOnlyBootstrapPrompt } from "@t3tools/shared/composerContextReferences";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";

import {
  resolveTimelineMinimapCurrentIndex,
  TIMELINE_MINIMAP_ITEM_SPACING,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";

const TIMELINE_MINIMAP_ARIA_EXCERPT_MAX_LENGTH = 120;
export const TIMELINE_MINIMAP_PREVIEW_MAX_LENGTH = 240;

export type TimelineMinimapKind = "user-turn" | "final-assistant";

export interface TimelineMinimapItem {
  readonly id: string;
  readonly rowIndex: number;
  readonly timestamp: string;
  /** Sent into this thread by another thread's agent. */
  readonly fromAgent: boolean;
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

const MARKDOWN_AUTOLINK = /<([a-z][\w+.-]*:[^\s<>]*)>/gi;

function compactMinimapPreview(text: string | null | undefined) {
  if (text && isAttachmentOnlyBootstrapPrompt(text)) return null;
  const compact =
    text
      // A thread autolink's only text is its URL.
      ?.replace(MARKDOWN_AUTOLINK, (link, href: string) =>
        parseThreadLinkHref(href) === null ? link : "a thread",
      )
      .replace(/\s+/g, " ")
      .trim() ?? "";
  return compact.length > 0 ? compact.slice(0, TIMELINE_MINIMAP_PREVIEW_MAX_LENGTH) : null;
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
  if ((cached.compactText?.length ?? 0) >= TIMELINE_MINIMAP_PREVIEW_MAX_LENGTH) {
    return cached.compactText;
  }

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
  return `${cached.compactText}${needsSpace ? " " : ""}${compactAppend}`.slice(
    0,
    TIMELINE_MINIMAP_PREVIEW_MAX_LENGTH,
  );
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
    previous.timestamp === item.timestamp &&
    previous.fromAgent === item.fromAgent &&
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
 * Derives both rails in one shared pass and reuses compact previews for unchanged message text. Streaming normalizes
 * only the appended response tail; historical previews and the unaffected rail
 * retain their identity.
 */
export function computeTimelineMinimapState(
  rows: ReadonlyArray<MessagesTimelineRow>,
  previous: TimelineMinimapState,
): TimelineMinimapState {
  const previousUserById = new Map(previous.userItems.map((item) => [item.id, item]));
  const previousAssistantById = new Map(previous.assistantItems.map((item) => [item.id, item]));
  const nextPreviewByRowId = new Map<string, TimelineMinimapPreviewCacheEntry>();
  const userItems: TimelineMinimapItem[] = [];
  const assistantItems: TimelineMinimapItem[] = [];
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
        timestamp: currentUserRow.message.createdAt,
        fromAgent: resolveUserMessagePresentation(currentUserRow.message).attribution === "agent",
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
          timestamp: row.message.updatedAt,
          fromAgent: false,
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

export function resolveTimelineMinimapTooltipTranslate(index: number, itemCount: number): string {
  if (index === 0) {
    return "0%";
  }
  if (index === itemCount - 1) {
    return "-100%";
  }
  return "-50%";
}

/** The strip a scrolled rail centers: the current one, or the first while reading above it. */
export function resolveTimelineMinimapAnchorIndex(
  input: Parameters<typeof resolveTimelineMinimapCurrentIndex>[0],
): number | null {
  const current = resolveTimelineMinimapCurrentIndex(input);
  return current === null && input.visibleEnd != null && input.rowIndices.length > 0 ? 0 : current;
}

const TIMELINE_MINIMAP_MIN_ITEM_SPACING = 3;

/** Squeezes strips toward the minimum spacing before a long rail starts scrolling. */
export function resolveTimelineMinimapSpacing(itemCount: number, railHeight: number): number {
  if (itemCount <= 1 || railHeight <= 0) {
    return TIMELINE_MINIMAP_ITEM_SPACING;
  }
  return Math.max(
    TIMELINE_MINIMAP_MIN_ITEM_SPACING,
    Math.min(TIMELINE_MINIMAP_ITEM_SPACING, railHeight / (itemCount - 1)),
  );
}

// Whole-pixel strip positions keep fractional spacing from blurring some strips brighter.
export function resolveTimelineMinimapStripTop(index: number, spacing: number): number {
  return Math.round(index * spacing);
}

/** Scrolls a rail taller than its box so the anchor strip stays centered. */
export function resolveTimelineMinimapScrollOffset(input: {
  readonly anchorIndex: number | null;
  readonly itemCount: number;
  readonly railHeight: number;
  readonly spacing: number;
}): number {
  if (input.railHeight <= 0) {
    return 0;
  }
  const overflow =
    resolveTimelineMinimapStripTop(input.itemCount - 1, input.spacing) - input.railHeight;
  if (overflow <= 0 || input.anchorIndex === null) {
    return overflow > 0 ? overflow : 0;
  }
  const centered =
    resolveTimelineMinimapStripTop(input.anchorIndex, input.spacing) - input.railHeight / 2;
  return Math.max(0, Math.min(overflow, Math.round(centered)));
}

export function resolveTimelineMinimapItemIndexFromPointer(input: {
  readonly itemCount: number;
  readonly railTop: number;
  readonly scrollOffset: number;
  readonly spacing: number;
  readonly pointerY: number;
}): number | null {
  if (input.itemCount <= 0) {
    return null;
  }
  const index = Math.round((input.pointerY - input.railTop + input.scrollOffset) / input.spacing);
  return Math.max(0, Math.min(input.itemCount - 1, index));
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
