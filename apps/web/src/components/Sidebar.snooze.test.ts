import { describe, expect, it } from "vite-plus/test";

import { resolveSnoozePresets } from "./Sidebar.snooze";

describe("resolveSnoozePresets", () => {
  it("leads with until-done only when offered", () => {
    const now = new Date(2026, 3, 8, 10, 0, 0, 0);
    const withoutOption = resolveSnoozePresets(now, "locale");
    expect(withoutOption.some((preset) => preset.id === "until-done")).toBe(false);
    const presets = resolveSnoozePresets(now, "locale", { untilDone: true });
    expect(presets[0]).toMatchObject({ id: "until-done", snoozedUntil: null, untilDone: true });
  });
});
