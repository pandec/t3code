import { describe, expect, it } from "vite-plus/test";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  computeTimelineMinimapState,
  EMPTY_TIMELINE_MINIMAP_STATE,
  resolveTimelineMinimapItemIndexFromPointer,
  resolveTimelineMinimapVisibleItemIds,
  type TimelineMinimapItem,
} from "./MessagesTimeline.minimap";

function messageRow(input: {
  id: string;
  role: "user" | "assistant";
  text: string;
  final?: boolean;
  streaming?: boolean;
}): Extract<MessagesTimelineRow, { kind: "message" }> {
  return {
    kind: "message",
    id: input.id,
    message: {
      id: input.id,
      role: input.role,
      text: input.text,
      streaming: input.streaming ?? false,
    },
    isFinalAssistantResponse: input.final ?? false,
  } as never;
}

describe("computeTimelineMinimapState", () => {
  it("reuses historical previews and the unaffected rail during streaming", () => {
    const rows = [
      messageRow({ id: "user-1", role: "user", text: "  First\n prompt  " }),
      messageRow({
        id: "assistant-1",
        role: "assistant",
        text: "First final response.",
        final: true,
      }),
      messageRow({ id: "user-2", role: "user", text: "Second prompt." }),
      messageRow({
        id: "assistant-stream",
        role: "assistant",
        text: "Streaming one \n",
        streaming: true,
      }),
    ];
    const initial = computeTimelineMinimapState(rows, EMPTY_TIMELINE_MINIMAP_STATE);
    const updated = computeTimelineMinimapState(
      [
        ...rows.slice(0, -1),
        messageRow({
          id: "assistant-stream",
          role: "assistant",
          text: "Streaming one \n more   chunk",
          streaming: true,
        }),
      ],
      initial,
    );

    expect(updated.previewByRowId.get("user-1")).toBe(initial.previewByRowId.get("user-1"));
    expect(updated.previewByRowId.get("assistant-1")).toBe(
      initial.previewByRowId.get("assistant-1"),
    );
    expect(updated.previewByRowId.get("user-2")).toBe(initial.previewByRowId.get("user-2"));
    expect(updated.previewByRowId.get("assistant-stream")).not.toBe(
      initial.previewByRowId.get("assistant-stream"),
    );
    expect(updated.userItems[0]).toBe(initial.userItems[0]);
    expect(updated.userItems[1]).not.toBe(initial.userItems[1]);
    expect(updated.userItems[1]?.secondaryText).toBe("Streaming one more chunk");
    expect(updated.assistantItems).toBe(initial.assistantItems);
  });

  it("bounds its preview cache to messages represented by the loaded rows", () => {
    const initial = computeTimelineMinimapState(
      [
        messageRow({ id: "user-1", role: "user", text: "First" }),
        messageRow({ id: "assistant-1", role: "assistant", text: "Done" }),
      ],
      EMPTY_TIMELINE_MINIMAP_STATE,
    );
    const replaced = computeTimelineMinimapState(
      [messageRow({ id: "user-2", role: "user", text: "Second" })],
      initial,
    );

    expect([...replaced.previewByRowId.keys()]).toEqual(["user-2"]);
  });
});

describe("resolveTimelineMinimapItemIndexFromPointer", () => {
  it("uses logarithmic lookup in the sorted turn-position space", () => {
    let positionReads = 0;
    const itemCount = 1_024;
    const items = Array.from({ length: itemCount }, (_, index) => ({
      positionCount: itemCount,
      get positionIndex() {
        positionReads += 1;
        return index;
      },
    }));

    expect(
      resolveTimelineMinimapItemIndexFromPointer({
        items,
        railTop: 0,
        railHeight: itemCount - 1,
        pointerY: 713.4,
      }),
    ).toBe(713);
    expect(positionReads).toBeLessThan(30);
  });

  it("keeps the earlier marker on an exact midpoint tie", () => {
    expect(
      resolveTimelineMinimapItemIndexFromPointer({
        items: [
          { positionCount: 4, positionIndex: 0 },
          { positionCount: 4, positionIndex: 2 },
        ],
        railTop: 0,
        railHeight: 2,
        pointerY: 2 / 3,
      }),
    ).toBe(0);
  });
});

describe("resolveTimelineMinimapVisibleItemIds", () => {
  it("measures only the binary-search path and visible markers", () => {
    let positionReads = 0;
    const items: TimelineMinimapItem[] = Array.from({ length: 1_024 }, (_, index) => ({
      id: `item-${index}`,
      rowIndex: index * 2,
      positionIndex: index,
      positionCount: 1_024,
      primaryText: null,
      secondaryText: null,
    }));

    expect(
      resolveTimelineMinimapVisibleItemIds({
        items,
        state: {
          positionAtIndex: (rowIndex) => {
            positionReads += 1;
            return rowIndex * 10;
          },
          sizeAtIndex: () => 5,
        },
        scrollTop: 10_000,
        scrollBottom: 10_025,
      }),
    ).toEqual(["item-500", "item-501"]);
    expect(positionReads).toBeLessThan(30);
  });

  it("falls back to a full scan when layout positions are incomplete", () => {
    const items: TimelineMinimapItem[] = [
      {
        id: "item-0",
        rowIndex: 0,
        positionIndex: 0,
        positionCount: 2,
        primaryText: null,
        secondaryText: null,
      },
      {
        id: "item-1",
        rowIndex: 1,
        positionIndex: 1,
        positionCount: 2,
        primaryText: null,
        secondaryText: null,
      },
    ];

    expect(
      resolveTimelineMinimapVisibleItemIds({
        items,
        state: {
          positionAtIndex: (rowIndex) => (rowIndex === 0 ? 0 : undefined),
          sizeAtIndex: () => 20,
        },
        scrollTop: 0,
        scrollBottom: 10,
      }),
    ).toEqual(["item-0"]);
  });
});
