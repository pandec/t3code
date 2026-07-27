import { describe, expect, it, vi } from "vite-plus/test";

import { buildHomeListFilterMenu } from "./home-list-filter-menu";

describe("buildHomeListFilterMenu", () => {
  it("adds a project scope submenu that selects and clears the same scope as the chips", () => {
    const onProjectChange = vi.fn();
    const menu = buildHomeListFilterMenu({
      environments: [],
      projects: [
        { key: "environment-1:project-1", label: "Codething" },
        { key: "environment-1:project-2", label: "Website" },
      ],
      models: [],
      selectedEnvironmentId: null,
      selectedProjectKey: "environment-1:project-1",
      selectedModel: null,
      projectSortOrder: "updated_at",
      threadSortOrder: "updated_at",
      onEnvironmentChange: vi.fn(),
      onProjectChange,
      onModelChange: vi.fn(),
      onProjectSortOrderChange: vi.fn(),
      onThreadSortOrderChange: vi.fn(),
    });

    const projectMenu = menu.items.find(
      (item) => item.type === "submenu" && item.title === "Project",
    );
    expect(menu.items.some((item) => item.title === "Settings")).toBe(false);
    expect(projectMenu).toMatchObject({
      type: "submenu",
      items: [
        { title: "All projects", state: "off" },
        { title: "Codething", state: "on" },
        { title: "Website", state: "off" },
      ],
    });
    if (projectMenu?.type !== "submenu") throw new Error("Expected project submenu");

    projectMenu.items[0]?.onPress();
    projectMenu.items[2]?.onPress();
    expect(onProjectChange).toHaveBeenNthCalledWith(1, null);
    expect(onProjectChange).toHaveBeenNthCalledWith(2, "environment-1:project-2");
  });

  it("adds a model submenu that pins and clears the model filter", () => {
    const onModelChange = vi.fn();
    const menu = buildHomeListFilterMenu({
      environments: [],
      projects: [],
      models: [
        { key: "claude-opus-4-5", label: "Opus 4.5" },
        { key: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
      ],
      selectedEnvironmentId: null,
      selectedProjectKey: null,
      selectedModel: "claude-opus-4-5",
      projectSortOrder: "updated_at",
      threadSortOrder: "updated_at",
      onEnvironmentChange: vi.fn(),
      onProjectChange: vi.fn(),
      onModelChange,
      onProjectSortOrderChange: vi.fn(),
      onThreadSortOrderChange: vi.fn(),
    });

    const modelMenu = menu.items.find((item) => item.type === "submenu" && item.title === "Model");
    expect(modelMenu).toMatchObject({
      type: "submenu",
      items: [
        { title: "All models", state: "off" },
        { title: "Opus 4.5", state: "on" },
        { title: "GPT-5.6 Sol", state: "off" },
      ],
    });
    if (modelMenu?.type !== "submenu") throw new Error("Expected model submenu");

    modelMenu.items[0]?.onPress();
    modelMenu.items[2]?.onPress();
    expect(onModelChange).toHaveBeenNthCalledWith(1, null);
    expect(onModelChange).toHaveBeenNthCalledWith(2, "gpt-5.6-sol");
  });

  it("omits the model submenu when no thread reports a model", () => {
    const menu = buildHomeListFilterMenu({
      environments: [],
      projects: [],
      models: [],
      selectedEnvironmentId: null,
      selectedProjectKey: null,
      selectedModel: null,
      projectSortOrder: "updated_at",
      threadSortOrder: "updated_at",
      onEnvironmentChange: vi.fn(),
      onProjectChange: vi.fn(),
      onModelChange: vi.fn(),
      onProjectSortOrderChange: vi.fn(),
      onThreadSortOrderChange: vi.fn(),
    });

    expect(menu.items.some((item) => item.title === "Model")).toBe(false);
  });
});
