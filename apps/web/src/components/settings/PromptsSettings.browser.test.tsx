import type { SavedPrompt } from "@t3tools/contracts/settings";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import type { SavedPrompts } from "~/hooks/useSavedPrompts";

const savedPrompts = vi.hoisted(() => ({ current: null as SavedPrompts | null }));

vi.mock(import("~/hooks/useSavedPrompts"), () => ({
  useSavedPrompts: () => savedPrompts.current!,
}));

// The real page container needs a router; this suite is about the prompt rows and editor.
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsPageContainer: (({ children }: { children: ReactNode }) => children) as never,
}));

import { PromptsSettings, SavedPromptRow } from "./PromptsSettings";

const multilinePrompt: SavedPrompt = {
  id: "prompt-1",
  title: "Review checklist",
  content: "First line of the prompt\nsecond line with more detail\n\nfourth line",
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  savedPrompts.current = null;
  vi.unstubAllGlobals();
});

const button = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const chevron = () => container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
const preview = () =>
  [...container.querySelectorAll("span")].find(
    (element) => element.textContent === "First line of the prompt",
  );

// The unstyled modal leaves its inert backdrop over the popup, so hit-tested clicks miss it.
async function clickText(text: string) {
  const target = [...document.querySelectorAll("button")].find(
    (element) => element.textContent === text,
  )!;
  await act(async () => target.click());
}

async function renderRow(canEdit: boolean, onEdit = vi.fn()) {
  await act(async () =>
    root.render(<SavedPromptRow prompt={multilinePrompt} canEdit={canEdit} onEdit={onEdit} />),
  );
  return onEdit;
}

describe("SavedPromptRow", () => {
  it("starts collapsed and expands in place to the exact multiline content", async () => {
    const onEdit = await renderRow(true);

    expect(chevron().getAttribute("aria-expanded")).toBe("false");
    expect(chevron().getAttribute("aria-label")).toBe("Expand Review checklist");
    const panelId = chevron().getAttribute("aria-controls")!;
    // Kept mounted while collapsed, so aria-controls always names a real element.
    expect(document.getElementById(panelId)).not.toBeNull();
    expect(preview()).toBeDefined();

    await userEvent.click(chevron());
    expect(chevron().getAttribute("aria-expanded")).toBe("true");
    expect(chevron().getAttribute("aria-label")).toBe("Collapse Review checklist");
    // The full content includes the first line, so the inline preview hides
    // while expanded to avoid reading it twice.
    expect(preview()).toBeUndefined();
    const content = document.getElementById(panelId)!.querySelector("p")!;
    expect(content.textContent).toBe(multilinePrompt.content);
    expect(content.className).toContain("whitespace-pre-wrap");
    // Expanding is view-only: the editor was never requested.
    expect(onEdit).not.toHaveBeenCalled();

    await userEvent.click(chevron());
    expect(chevron().getAttribute("aria-expanded")).toBe("false");
  });

  it("renders the chevron immediately before Edit, with Edit last", async () => {
    await renderRow(true);
    const edit = button(`Edit ${multilinePrompt.title}`)!;
    expect(chevron().nextElementSibling).toBe(edit);
    expect(edit.nextElementSibling).toBeNull();
  });

  it("keeps expansion enabled while Edit is disabled in read-only mode", async () => {
    const onEdit = await renderRow(false);
    expect(button(`Edit ${multilinePrompt.title}`)!.disabled).toBe(true);
    expect(chevron().disabled).toBe(false);

    await userEvent.click(chevron());
    expect(chevron().getAttribute("aria-expanded")).toBe("true");
    expect(onEdit).not.toHaveBeenCalled();
  });
});

describe("PromptsSettings", () => {
  it("renders one row per prompt and Edit opens the editor filled with that prompt", async () => {
    const second: SavedPrompt = { id: "prompt-2", title: "Second", content: "Body" };
    const saveAll = vi.fn();
    savedPrompts.current = {
      prompts: [multilinePrompt, second],
      hasConnectedEnvironment: true,
      canEdit: true,
      saveAll,
    };
    await act(async () => root.render(<PromptsSettings />));

    expect(button("Edit Review checklist")).not.toBeNull();
    expect(button("Edit Second")).not.toBeNull();

    const titleInput = () => document.querySelector<HTMLInputElement>("#saved-prompt-title");
    const contentInput = () => document.querySelector<HTMLTextAreaElement>("#saved-prompt-content");

    await userEvent.click(button("Edit Review checklist")!);
    await vi.waitFor(() => expect(titleInput()?.value).toBe(multilinePrompt.title));
    expect(contentInput()?.value).toBe(multilinePrompt.content);

    // A later request refills the form instead of keeping the previous prompt's draft.
    await clickText("Cancel");
    await act(async () => button("Edit Second")!.click());
    await vi.waitFor(() => expect(titleInput()?.value).toBe(second.title));
    expect(contentInput()?.value).toBe(second.content);

    await userEvent.fill(titleInput()!, "Renamed");
    await clickText("Save changes");
    expect(saveAll).toHaveBeenCalledOnce();
    const update = saveAll.mock.calls[0]![0] as (
      current: ReadonlyArray<SavedPrompt>,
    ) => ReadonlyArray<SavedPrompt>;
    expect(update([multilinePrompt, second])).toEqual([
      multilinePrompt,
      { ...second, title: "Renamed" },
    ]);
  });
});
