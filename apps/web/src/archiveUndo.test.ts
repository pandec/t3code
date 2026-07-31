import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createThreadActionUndoHistory,
  hasOpenArchiveUndoBlockingLayer,
  isArchiveUndoShortcut,
  isEditableKeyboardTarget,
  resolveEmptyDraftIdForArchiveUndo,
} from "./archiveUndo";

function threadRef(threadId: string) {
  return scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make(threadId));
}

describe("thread action undo history", () => {
  it("keeps only the latest successful archive or snooze and consumes it once", () => {
    const history = createThreadActionUndoHistory();
    history.arm({
      action: "archive",
      threadRef: threadRef("thread-1"),
      threadTitle: "First",
    });
    const latest = history.arm({
      action: "snooze",
      threadRef: threadRef("thread-2"),
      threadTitle: "Second",
    });

    expect(history.take()).toEqual(latest);
    expect(history.take()).toBeNull();
  });

  it("restores a failed candidate without replacing a newer action", () => {
    const history = createThreadActionUndoHistory();
    const first = history.arm({
      action: "archive",
      threadRef: threadRef("thread-1"),
      threadTitle: "First",
    });
    expect(history.take()).toEqual(first);

    const second = history.arm({
      action: "snooze",
      threadRef: threadRef("thread-2"),
      threadTitle: "Second",
    });
    history.restore(first);

    expect(history.take()).toEqual(second);
  });

  it("discards a candidate reversed through another UI", () => {
    const history = createThreadActionUndoHistory();
    history.arm({
      action: "snooze",
      threadRef: threadRef("thread-1"),
      threadTitle: "First",
    });

    history.discard(threadRef("thread-1"));

    expect(history.take()).toBeNull();
  });
});

describe("archive undo shortcut", () => {
  it("matches unmodified Command+Z only", () => {
    const commandZ = {
      key: "z",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      repeat: false,
    };

    expect(isArchiveUndoShortcut(commandZ)).toBe(true);
    expect(isArchiveUndoShortcut({ ...commandZ, shiftKey: true })).toBe(false);
    expect(isArchiveUndoShortcut({ ...commandZ, metaKey: false, ctrlKey: true })).toBe(false);
    expect(isArchiveUndoShortcut({ ...commandZ, repeat: true })).toBe(false);
  });

  it("recognizes targets contained by editable elements", () => {
    const editableTarget = {
      closest: () => ({ contentEditable: "true" }),
    } as unknown as EventTarget;
    const nonEditableTarget = {
      closest: () => null,
    } as unknown as EventTarget;

    expect(isEditableKeyboardTarget(editableTarget)).toBe(true);
    expect(isEditableKeyboardTarget(nonEditableTarget)).toBe(false);
    expect(isEditableKeyboardTarget(null)).toBe(false);
  });

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
