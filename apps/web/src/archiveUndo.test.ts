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
    const openRoot = {
      querySelectorAll: () => [{ closest: () => null }],
    } as unknown as Pick<Document, "querySelectorAll">;
    const closedRoot = {
      querySelectorAll: () => [],
    } as unknown as Pick<Document, "querySelectorAll">;

    expect(hasOpenArchiveUndoBlockingLayer(openRoot)).toBe(true);
    expect(hasOpenArchiveUndoBlockingLayer(closedRoot)).toBe(false);
    expect(hasOpenArchiveUndoBlockingLayer(null)).toBe(false);
  });

  it("ignores retained closed layers but still blocks on another open layer", () => {
    const closedLayer = { closest: (): object | null => ({}) };
    const layers = [closedLayer];
    const root = {
      querySelectorAll: () => layers,
    } as unknown as Pick<Document, "querySelectorAll">;

    expect(hasOpenArchiveUndoBlockingLayer(root)).toBe(false);
    layers.push({ closest: () => null });
    expect(hasOpenArchiveUndoBlockingLayer(root)).toBe(true);
  });

  it("blocks generic aria-modal dialogs", () => {
    let queriedSelector = "";
    const root = {
      querySelectorAll: (selector: string) => {
        queriedSelector = selector;
        return [];
      },
    } as unknown as Pick<Document, "querySelectorAll">;

    hasOpenArchiveUndoBlockingLayer(root);

    expect(queriedSelector).toContain('[aria-modal="true"]');
  });
});
