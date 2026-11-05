import { describe, expect, it } from "vite-plus/test";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  computeTimelineMinimapState,
  deriveTimelineMinimapItems,
  EMPTY_TIMELINE_MINIMAP_STATE,
  resolveTimelineMinimapAnchorIndex,
  resolveTimelineMinimapAriaLabel,
  resolveTimelineMinimapItemIndexFromPointer,
  resolveTimelineMinimapScrollOffset,
  resolveTimelineMinimapSpacing,
  resolveTimelineMinimapTooltipTranslate,
  TIMELINE_MINIMAP_PREVIEW_MAX_LENGTH,
} from "./MessagesTimeline.minimap";

function messageRow(input: {
  id: string;
  role: "user" | "assistant";
  text: string;
  final?: boolean;
  streaming?: boolean;
  createdBy?: "user" | "agent";
}): Extract<MessagesTimelineRow, { kind: "message" }> {
  return {
    kind: "message",
    id: input.id,
    message: {
      id: input.id,
      role: input.role,
      text: input.text,
      streaming: input.streaming ?? false,
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
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
  it("only edge-clamps markers at the endpoints of the rail", () => {
    expect(resolveTimelineMinimapTooltipTranslate(0, 5)).toBe("0%");
    expect(resolveTimelineMinimapTooltipTranslate(1, 5)).toBe("-50%");
    expect(resolveTimelineMinimapTooltipTranslate(3, 5)).toBe("-50%");
    expect(resolveTimelineMinimapTooltipTranslate(4, 5)).toBe("-100%");
  });
});

describe("deriveTimelineMinimapItems", () => {
  it("lists replies in order without gaps and flags messages from other agents", () => {
    const rows = [
      messageRow({ id: "user-1", role: "user", text: "user-1" }),
      messageRow({ id: "assistant-1", role: "assistant", text: "assistant-1", final: true }),
      messageRow({ id: "user-2", role: "user", text: "user-2" }),
      messageRow({
        id: "assistant-commentary",
        role: "assistant",
        text: "assistant-commentary",
      }),
      messageRow({ id: "user-3", role: "user", text: "user-3", createdBy: "agent" }),
      messageRow({ id: "assistant-3", role: "assistant", text: "assistant-3", final: true }),
    ];

    expect(deriveTimelineMinimapItems(rows, "final-assistant").map(({ id }) => id)).toEqual([
      "assistant-1",
      "assistant-3",
    ]);
    expect(
      deriveTimelineMinimapItems(rows, "user-turn").map(({ id, fromAgent }) => [id, fromAgent]),
    ).toEqual([
      ["user-1", false],
      ["user-2", false],
      ["user-3", true],
    ]);
  });

  it.each(["", "Ultrathink:\n"])("omits the attachment-only bootstrap prompt (%j)", (prefix) => {
    const rows = [
      messageRow({
        id: "image-only",
        role: "user",
        text: prefix + ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
      }),
    ];

    expect(deriveTimelineMinimapItems(rows, "user-turn")[0]?.primaryText).toBeNull();
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

describe("resolveTimelineMinimapAnchorIndex", () => {
  it("anchors the first strip while reading above it, and nothing before layout", () => {
    const rowIndices = [4, 9, 14];

    expect(resolveTimelineMinimapAnchorIndex({ visibleStart: 0, visibleEnd: 2, rowIndices })).toBe(
      0,
    );
    expect(
      resolveTimelineMinimapAnchorIndex({ visibleStart: 10, visibleEnd: 12, rowIndices }),
    ).toBe(1);
    expect(
      resolveTimelineMinimapAnchorIndex({ visibleStart: null, visibleEnd: null, rowIndices }),
    ).toBeNull();
  });
});

describe("resolveTimelineMinimapSpacing", () => {
  it("squeezes strips to fit the rail, down to the minimum before scrolling", () => {
    expect(resolveTimelineMinimapSpacing(11, 200)).toBe(8);
    expect(resolveTimelineMinimapSpacing(11, 50)).toBe(5);
    expect(resolveTimelineMinimapSpacing(101, 100)).toBe(3);
    expect(resolveTimelineMinimapSpacing(11, 0)).toBe(8);
  });
});

describe("resolveTimelineMinimapScrollOffset", () => {
  it("keeps a fitting rail still and centers the anchor of an overflowing one", () => {
    // 11 strips at 8px span 80px.
    const input = { itemCount: 11, railHeight: 40, spacing: 8 };

    expect(resolveTimelineMinimapScrollOffset({ ...input, anchorIndex: 5, railHeight: 80 })).toBe(
      0,
    );
    expect(resolveTimelineMinimapScrollOffset({ ...input, anchorIndex: 5 })).toBe(20);
    expect(resolveTimelineMinimapScrollOffset({ ...input, anchorIndex: 0 })).toBe(0);
    expect(resolveTimelineMinimapScrollOffset({ ...input, anchorIndex: 10 })).toBe(40);
    expect(resolveTimelineMinimapScrollOffset({ ...input, anchorIndex: null })).toBe(40);
  });
});

describe("resolveTimelineMinimapItemIndexFromPointer", () => {
  it("maps the pointer to the nearest strip in the scrolled rail", () => {
    const input = { itemCount: 11, railTop: 100, scrollOffset: 20, spacing: 8 };

    expect(resolveTimelineMinimapItemIndexFromPointer({ ...input, pointerY: 100 })).toBe(3);
    expect(resolveTimelineMinimapItemIndexFromPointer({ ...input, pointerY: 103 })).toBe(3);
    expect(resolveTimelineMinimapItemIndexFromPointer({ ...input, pointerY: 109 })).toBe(4);
    expect(resolveTimelineMinimapItemIndexFromPointer({ ...input, pointerY: 0 })).toBe(0);
    expect(resolveTimelineMinimapItemIndexFromPointer({ ...input, pointerY: 900 })).toBe(10);
    expect(
      resolveTimelineMinimapItemIndexFromPointer({ ...input, itemCount: 0, pointerY: 100 }),
    ).toBeNull();
  });
});
