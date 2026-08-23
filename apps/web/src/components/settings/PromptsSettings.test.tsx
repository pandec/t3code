import type { SavedPrompt } from "@t3tools/contracts/settings";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useId: () => "saved-prompt-content",
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("~/hooks/useSavedPrompts", () => ({
  useSavedPrompts: vi.fn(),
}));

import { useSavedPrompts, type SavedPrompts } from "~/hooks/useSavedPrompts";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import { PromptsSettings, SavedPromptRow } from "./PromptsSettings";

type Elem = ReactElement<Record<string, unknown>>;

const multilinePrompt: SavedPrompt = {
  id: "prompt-1",
  title: "Review checklist",
  content: "First line of the prompt\nsecond line with more detail\n\nfourth line",
};

function mockSavedPrompts(overrides: Partial<SavedPrompts> = {}): void {
  vi.mocked(useSavedPrompts).mockReturnValue({
    prompts: [multilinePrompt],
    hasConnectedEnvironment: true,
    canEdit: true,
    saveAll: vi.fn(),
    ...overrides,
  });
}

function renderRow(props: Parameters<typeof SavedPromptRow>[0]): Elem {
  hooks.beginRender();
  return SavedPromptRow(props) as Elem;
}

function findChevron(row: Elem): Elem | null {
  return visitElements(row, (element) => typeof element.props["aria-expanded"] === "boolean");
}

function findEdit(row: Elem): Elem | null {
  return visitElements(
    row,
    (element) => element.props["aria-label"] === `Edit ${multilinePrompt.title}`,
  );
}

describe("SavedPromptRow", () => {
  beforeEach(() => {
    hooks.reset();
  });

  it("starts collapsed and expands in place to the exact multiline content", () => {
    const onEdit = vi.fn();
    let row = renderRow({ prompt: multilinePrompt, canEdit: true, onEdit });

    const collapsedChevron = findChevron(row);
    expect(collapsedChevron?.props["aria-controls"]).toBe("saved-prompt-content");
    expect(collapsedChevron?.props["aria-expanded"]).toBe(false);
    expect(collapsedChevron?.props["aria-label"]).toBe("Expand Review checklist");
    expect(visitElements(row, (element) => element.type === Collapsible)?.props.open).toBe(false);

    const collapsedPanel = visitElements(row, (element) => element.type === CollapsibleContent);
    expect(collapsedPanel?.props.id).toBe("saved-prompt-content");
    expect(collapsedPanel?.props.keepMounted).toBe(true);

    (collapsedChevron?.props.onClick as (() => void) | undefined)?.();
    row = renderRow({ prompt: multilinePrompt, canEdit: true, onEdit });

    const openChevron = findChevron(row);
    expect(openChevron?.props["aria-expanded"]).toBe(true);
    expect(openChevron?.props["aria-label"]).toBe("Collapse Review checklist");
    expect(visitElements(row, (element) => element.type === Collapsible)?.props.open).toBe(true);

    const panel = visitElements(row, (element) => element.type === CollapsibleContent);
    const content = visitElements(
      panel,
      (element) => element.props.children === multilinePrompt.content,
    );
    expect(content?.type).toBe("p");
    expect(content?.props.className).toContain("whitespace-pre-wrap");

    // Expanding is view-only: the editor was never requested.
    expect(onEdit).not.toHaveBeenCalled();

    (openChevron?.props.onClick as (() => void) | undefined)?.();
    row = renderRow({ prompt: multilinePrompt, canEdit: true, onEdit });
    expect(findChevron(row)?.props["aria-expanded"]).toBe(false);
  });

  it("renders the chevron immediately before Edit, with Edit last", () => {
    const row = renderRow({ prompt: multilinePrompt, canEdit: true, onEdit: vi.fn() });
    const chevron = findChevron(row);
    const edit = findEdit(row);
    const rail = visitElements(row, (element) => {
      const children = element.props.children;
      return Array.isArray(children) && children.includes(edit);
    });

    const actions = rail?.props.children as ReadonlyArray<Elem>;
    expect(actions.at(-1)).toBe(edit);
    expect(actions.indexOf(chevron as Elem)).toBe(actions.length - 2);
  });

  it("keeps expansion enabled while Edit is disabled in read-only mode", () => {
    const onEdit = vi.fn();
    let row = renderRow({ prompt: multilinePrompt, canEdit: false, onEdit });

    expect(findEdit(row)?.props.disabled).toBe(true);
    const chevron = findChevron(row);
    expect(chevron?.props.disabled).toBeUndefined();

    (chevron?.props.onClick as (() => void) | undefined)?.();
    row = renderRow({ prompt: multilinePrompt, canEdit: false, onEdit });
    expect(findChevron(row)?.props["aria-expanded"]).toBe(true);
    expect(onEdit).not.toHaveBeenCalled();
  });
});

describe("PromptsSettings", () => {
  beforeEach(() => {
    hooks.reset();
    vi.mocked(useSavedPrompts).mockReset();
  });

  it("renders one row per prompt and Edit still opens the editor dialog", () => {
    const second: SavedPrompt = { id: "prompt-2", title: "Second", content: "Body" };
    mockSavedPrompts({ prompts: [multilinePrompt, second] });

    hooks.beginRender();
    let tree = PromptsSettings() as Elem;
    const rows: Elem[] = [];
    visitElements(tree, (element) => {
      if (element.type === SavedPromptRow) rows.push(element);
      return false;
    });
    expect(rows.map((row) => (row.props.prompt as SavedPrompt).id)).toEqual([
      "prompt-1",
      "prompt-2",
    ]);
    expect(rows.map((row) => row.props.canEdit)).toEqual([true, true]);

    (rows[0]?.props.onEdit as (() => void) | undefined)?.();
    hooks.beginRender();
    tree = PromptsSettings() as Elem;
    const dialog = visitElements(
      tree,
      (element) => "request" in element.props && element.props.request !== null,
    );
    expect(dialog?.props.request).toEqual({
      promptId: "prompt-1",
      initial: { title: multilinePrompt.title, content: multilinePrompt.content },
    });
  });
});
