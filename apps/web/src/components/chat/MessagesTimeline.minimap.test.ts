import { describe, expect, it } from "vite-plus/test";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  computeTimelineMinimapState,
  deriveTimelineMinimapItems,
  EMPTY_TIMELINE_MINIMAP_STATE,
  resolveTimelineMinimapAriaLabel,
  resolveTimelineMinimapItemIndexFromPointer,
  resolveTimelineMinimapTooltipTranslate,
  resolveTimelineMinimapVisibleItemIds,
  TIMELINE_MINIMAP_PREVIEW_MAX_LENGTH,
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

describe("resolveTimelineMinimapAriaLabel", () => {
  it("uses a concise role and position label with a capped excerpt", () => {
    const longResponse = "A".repeat(180);

    expect(
      resolveTimelineMinimapAriaLabel({
        activeIndex: null,
        itemCount: 3,
        primaryText: null,
        side: "right",
      }),
    ).toBe("Jump to message: Agent response");
    expect(
      resolveTimelineMinimapAriaLabel({
        activeIndex: 1,
        itemCount: 3,
        primaryText: longResponse,
        side: "right",
      }),
    ).toBe(`Jump to agent response 2 of 3: ${"A".repeat(120)}`);
  });
});

describe("resolveTimelineMinimapTooltipTranslate", () => {
  it("only edge-clamps markers at the endpoints of the full turn space", () => {
    expect(resolveTimelineMinimapTooltipTranslate(0, 5)).toBe("0%");
    expect(resolveTimelineMinimapTooltipTranslate(1, 5)).toBe("-50%");
    expect(resolveTimelineMinimapTooltipTranslate(3, 5)).toBe("-50%");
    expect(resolveTimelineMinimapTooltipTranslate(4, 5)).toBe("-100%");
  });
});

describe("deriveTimelineMinimapItems", () => {
  it("keeps sparse agent replies aligned with their user-turn positions", () => {
    const rows = [
      messageRow({ id: "user-1", role: "user", text: "user-1" }),
      messageRow({ id: "assistant-1", role: "assistant", text: "assistant-1", final: true }),
      messageRow({ id: "user-2", role: "user", text: "user-2" }),
      messageRow({
        id: "assistant-commentary",
        role: "assistant",
        text: "assistant-commentary",
      }),
      messageRow({ id: "user-3", role: "user", text: "user-3" }),
      messageRow({ id: "assistant-3", role: "assistant", text: "assistant-3", final: true }),
    ];

    expect(
      deriveTimelineMinimapItems(rows, "final-assistant").map(
        ({ id, positionIndex, positionCount }) => ({ id, positionIndex, positionCount }),
      ),
    ).toEqual([
      { id: "assistant-1", positionIndex: 0, positionCount: 3 },
      { id: "assistant-3", positionIndex: 2, positionCount: 3 },
    ]);
  });
});

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

  it("caps compact previews and reuses marker output after the cap", () => {
    const prefix = "A".repeat(TIMELINE_MINIMAP_PREVIEW_MAX_LENGTH - 2);
    const user = messageRow({ id: "user", role: "user", text: "Prompt" });
    const initial = computeTimelineMinimapState(
      [
        user,
        messageRow({
          id: "assistant",
          role: "assistant",
          text: `${prefix} `,
          streaming: true,
        }),
      ],
      EMPTY_TIMELINE_MINIMAP_STATE,
    );
    const capped = computeTimelineMinimapState(
      [
        user,
        messageRow({
          id: "assistant",
          role: "assistant",
          text: `${prefix} word`,
          streaming: true,
        }),
      ],
      initial,
    );
    const afterCap = computeTimelineMinimapState(
      [
        user,
        messageRow({
          id: "assistant",
          role: "assistant",
          text: `${prefix} word more text`,
          streaming: true,
        }),
      ],
      capped,
    );

    expect(capped.userItems[0]?.secondaryText).toBe(`${prefix} w`);
    expect(capped.userItems[0]?.secondaryText).toHaveLength(TIMELINE_MINIMAP_PREVIEW_MAX_LENGTH);
    expect(afterCap.userItems[0]).toBe(capped.userItems[0]);
    expect(afterCap.previewByRowId.get("assistant")).not.toBe(
      capped.previewByRowId.get("assistant"),
    );
  });

  it("provides a new visibility refresh token for same-length layout changes", () => {
    const user = messageRow({ id: "user", role: "user", text: "Prompt" });
    const assistant = messageRow({
      id: "assistant",
      role: "assistant",
      text: "Response",
      final: true,
    });
    const workRow = (label: string) =>
      ({
        kind: "work",
        id: "work",
        createdAt: "2026-08-23T00:00:00.000Z",
        groupedEntries: [{ label }],
        isExpandedToolGroupEntry: false,
        isLastExpandedToolGroupEntry: false,
      }) as never;
    const initial = computeTimelineMinimapState(
      [user, workRow("Short"), assistant],
      EMPTY_TIMELINE_MINIMAP_STATE,
    );
    const updated = computeTimelineMinimapState(
      [user, workRow("A much longer work row that can change layout"), assistant],
      initial,
    );

    expect(updated).not.toBe(initial);
    expect(updated.userItems).toBe(initial.userItems);
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
  it("selects the nearest rendered reply in the full turn-position space", () => {
    const items = [
      { positionIndex: 0, positionCount: 4 },
      { positionIndex: 3, positionCount: 4 },
    ];

    expect(
      resolveTimelineMinimapItemIndexFromPointer({
        items,
        railTop: 100,
        railHeight: 300,
        pointerY: 360,
      }),
    ).toBe(1);
    expect(
      resolveTimelineMinimapItemIndexFromPointer({
        items,
        railTop: 100,
        railHeight: 300,
        pointerY: 160,
      }),
    ).toBe(0);
  });

  it("compares sparse markers against the continuous pointer position", () => {
    expect(
      resolveTimelineMinimapItemIndexFromPointer({
        items: [
          { positionIndex: 0, positionCount: 4 },
          { positionIndex: 2, positionCount: 4 },
        ],
        railTop: 0,
        railHeight: 24,
        pointerY: 11,
      }),
    ).toBe(1);
  });

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
