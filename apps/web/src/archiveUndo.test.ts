import { describe, expect, it } from "vite-plus/test";

import { hasOpenArchiveUndoBlockingLayer, resolveEmptyDraftIdForArchiveUndo } from "./archiveUndo";

describe("archive undo guards", () => {
  it("opens restored threads only from an empty draft route", () => {
    const draftRoute = { kind: "draft" as const, draftId: "draft-1" };

    expect(resolveEmptyDraftIdForArchiveUndo(draftRoute, false, false)).toBe("draft-1");
    expect(resolveEmptyDraftIdForArchiveUndo(draftRoute, true, false)).toBeNull();
    expect(resolveEmptyDraftIdForArchiveUndo(draftRoute, false, true)).toBeNull();
    expect(resolveEmptyDraftIdForArchiveUndo({ kind: "server" }, false, false)).toBeNull();
    expect(resolveEmptyDraftIdForArchiveUndo(null, false, false)).toBeNull();
  });

  it("blocks archive undo while a floating interaction layer is open", () => {
    const openRoot = { querySelector: () => ({}) } as unknown as Pick<Document, "querySelector">;
    const closedRoot = { querySelector: () => null } as unknown as Pick<Document, "querySelector">;

    expect(hasOpenArchiveUndoBlockingLayer(openRoot)).toBe(true);
    expect(hasOpenArchiveUndoBlockingLayer(closedRoot)).toBe(false);
    expect(hasOpenArchiveUndoBlockingLayer(null)).toBe(false);
  });

  it("blocks generic aria-modal dialogs", () => {
    let queriedSelector = "";
    const root = {
      querySelector: (selector: string) => {
        queriedSelector = selector;
        return null;
      },
    } as unknown as Pick<Document, "querySelector">;

    hasOpenArchiveUndoBlockingLayer(root);

    expect(queriedSelector).toContain('[aria-modal="true"]');
  });
});
