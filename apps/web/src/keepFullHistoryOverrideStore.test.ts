import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useKeepFullHistoryOverrideStore } from "./keepFullHistoryOverrideStore";

describe("keepFullHistoryOverrideStore", () => {
  beforeEach(() => {
    useKeepFullHistoryOverrideStore.setState({ overrides: new Map() });
  });

  it("keeps overrides per thread and drops them on null", () => {
    const { setOverride } = useKeepFullHistoryOverrideStore.getState();
    setOverride("env-a:thread-1", true);
    setOverride("env-b:thread-1", false);
    expect(useKeepFullHistoryOverrideStore.getState().overrides).toEqual(
      new Map([
        ["env-a:thread-1", true],
        ["env-b:thread-1", false],
      ]),
    );

    setOverride("env-a:thread-1", null);
    expect(useKeepFullHistoryOverrideStore.getState().overrides).toEqual(
      new Map([["env-b:thread-1", false]]),
    );
  });

  it("leaves state untouched when nothing changes", () => {
    const { setOverride } = useKeepFullHistoryOverrideStore.getState();
    setOverride("env-a:thread-1", true);
    const before = useKeepFullHistoryOverrideStore.getState().overrides;
    setOverride("env-a:thread-1", true);
    setOverride("env-a:thread-2", null);
    expect(useKeepFullHistoryOverrideStore.getState().overrides).toBe(before);
  });
});
