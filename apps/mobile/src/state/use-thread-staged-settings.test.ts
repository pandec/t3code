import { afterEach, describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";

import { appAtomRegistry } from "./atom-registry";
import {
  clearStagedThreadSettings,
  getStagedThreadSettings,
  pruneExpiredStagedThreadSettings,
  removeStagedThreadSettingsForEnvironment,
  resolveStagedThreadSettings,
  stageThreadSettings,
  threadStagedSettingsAtom,
  type ThreadSettings,
} from "./use-thread-staged-settings";

const baseline: ThreadSettings = {
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
    options: [{ id: "reasoningEffort", value: "high" }],
  },
  runtimeMode: "approval-required",
  interactionMode: "default",
};

const stagedModel = {
  instanceId: ProviderInstanceId.make("claude"),
  model: "claude-opus-4-1",
};

const thirdModel = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.6",
};

afterEach(() => {
  appAtomRegistry.set(threadStagedSettingsAtom, {});
});

describe("thread staged settings", () => {
  it("honors a staged value while the thread still matches its structural baseline", () => {
    const threadKey = "environment-1:thread-1";
    stageThreadSettings(threadKey, { modelSelection: stagedModel }, baseline);

    expect(
      resolveStagedThreadSettings(getStagedThreadSettings(threadKey), {
        ...baseline,
        modelSelection: {
          ...baseline.modelSelection,
          options: baseline.modelSelection.options?.map((option) => ({ ...option })),
        },
      }),
    ).toEqual({ ...baseline, modelSelection: stagedModel });
  });

  it("falls through when the thread converges to the staged value", () => {
    const threadKey = "environment-1:thread-1";
    stageThreadSettings(threadKey, { modelSelection: stagedModel }, baseline);
    const converged = { ...baseline, modelSelection: stagedModel };

    expect(resolveStagedThreadSettings(getStagedThreadSettings(threadKey), converged)).toEqual(
      converged,
    );
  });

  it("falls through when the thread diverges to a third value", () => {
    const threadKey = "environment-1:thread-1";
    stageThreadSettings(threadKey, { modelSelection: stagedModel }, baseline);
    const diverged = { ...baseline, modelSelection: thirdModel };

    expect(resolveStagedThreadSettings(getStagedThreadSettings(threadKey), diverged)).toEqual(
      diverged,
    );
  });

  it("invalidates fields independently", () => {
    const threadKey = "environment-1:thread-1";
    stageThreadSettings(
      threadKey,
      {
        modelSelection: stagedModel,
        runtimeMode: "full-access",
        interactionMode: "plan",
      },
      baseline,
    );

    expect(
      resolveStagedThreadSettings(getStagedThreadSettings(threadKey), {
        ...baseline,
        runtimeMode: "full-access",
      }),
    ).toEqual({
      modelSelection: stagedModel,
      runtimeMode: "full-access",
      interactionMode: "plan",
    });
  });

  it("never revives an expired override when the thread returns to its baseline", () => {
    const threadKey = "environment-1:thread-1";
    stageThreadSettings(
      threadKey,
      { modelSelection: stagedModel, interactionMode: "plan" },
      baseline,
    );

    // The thread moves off the model baseline (e.g. a pick on another
    // client); the interaction mode stays on its baseline and survives.
    pruneExpiredStagedThreadSettings(threadKey, { ...baseline, modelSelection: thirdModel });
    expect(getStagedThreadSettings(threadKey)).toEqual({
      interactionMode: { value: "plan", baseline: baseline.interactionMode },
    });

    // Returning to the original baseline must not resurrect the model pick.
    expect(resolveStagedThreadSettings(getStagedThreadSettings(threadKey), baseline)).toEqual({
      ...baseline,
      interactionMode: "plan",
    });

    // Once every field expires, the entry is deleted entirely.
    pruneExpiredStagedThreadSettings(threadKey, { ...baseline, interactionMode: "plan" });
    expect(getStagedThreadSettings(threadKey)).toBeUndefined();
  });

  it("clears one thread and removes only the selected environment", () => {
    const removedEnvironmentId = EnvironmentId.make("environment-removed");
    const retainedEnvironmentId = EnvironmentId.make("environment-retained");
    const firstRemovedKey = `${removedEnvironmentId}:thread-1`;
    const secondRemovedKey = `${removedEnvironmentId}:thread-2`;
    const retainedKey = `${retainedEnvironmentId}:thread-1`;
    stageThreadSettings(firstRemovedKey, { modelSelection: stagedModel }, baseline);
    stageThreadSettings(secondRemovedKey, { runtimeMode: "full-access" }, baseline);
    stageThreadSettings(retainedKey, { interactionMode: "plan" }, baseline);

    clearStagedThreadSettings(firstRemovedKey);
    expect(getStagedThreadSettings(firstRemovedKey)).toBeUndefined();
    removeStagedThreadSettingsForEnvironment(removedEnvironmentId);

    expect(appAtomRegistry.get(threadStagedSettingsAtom)).toEqual({
      [retainedKey]: {
        interactionMode: { value: "plan", baseline: baseline.interactionMode },
      },
    });
  });
});
