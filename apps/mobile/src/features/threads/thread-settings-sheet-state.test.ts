import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId, type ProviderOptionSelection } from "@t3tools/contracts";

import type { ModelOption } from "../../lib/modelOptions";
import {
  pendingModelAfterPress,
  sheetPresentationPhaseAfterEvent,
  type SheetPresentationPhase,
} from "./thread-settings-sheet-state";

function modelOption(
  model: string,
  options: ReadonlyArray<ProviderOptionSelection> = [],
): ModelOption {
  return {
    key: `codex:${model}`,
    label: model,
    subtitle: "Codex",
    providerKey: "codex",
    providerLabel: "Codex",
    providerDriver: "codex",
    isDefault: false,
    isLegacy: false,
    capabilities: null,
    selection: {
      instanceId: ProviderInstanceId.make("codex"),
      model,
      options,
    },
  };
}

describe("thread settings sheet state", () => {
  it("clears staging when the applied model is pressed", () => {
    expect(
      pendingModelAfterPress({
        current: modelOption("gpt-next"),
        pressed: modelOption("gpt-current"),
        pressedIsApplied: true,
      }),
    ).toBeNull();
  });

  it("preserves staged options when the highlighted model is pressed again", () => {
    const pending = modelOption("gpt-next", [{ id: "effort", value: "high" }]);

    expect(
      pendingModelAfterPress({
        current: pending,
        pressed: modelOption("gpt-next"),
        pressedIsApplied: false,
      }),
    ).toBe(pending);
  });

  it("stages a different model", () => {
    const pressed = modelOption("gpt-other");

    expect(
      pendingModelAfterPress({
        current: modelOption("gpt-next"),
        pressed,
        pressedIsApplied: false,
      }),
    ).toBe(pressed);
  });
});

describe("sheet presentation phases", () => {
  it("walks the happy path open → visible → closing → closed", () => {
    let phase: SheetPresentationPhase = "closed";
    for (const [event, expected] of [
      ["open", "opening"],
      ["keyboard-dismissed", "visible"],
      ["close", "closing"],
      ["dismissed", "closed"],
    ] as const) {
      const next = sheetPresentationPhaseAfterEvent(phase, event);
      expect(next).toBe(expected);
      phase = next as SheetPresentationPhase;
    }
  });

  it("ignores open while a presentation is active", () => {
    expect(sheetPresentationPhaseAfterEvent("opening", "open")).toBeNull();
    expect(sheetPresentationPhaseAfterEvent("visible", "open")).toBeNull();
    expect(sheetPresentationPhaseAfterEvent("closing", "open")).toBeNull();
  });

  it("recovers when the sheet unmounts mid-presentation", () => {
    // The new-task screen unmounts a presented sheet when its project
    // disappears; the unmount-reported dismissal must unlock the trigger
    // from any in-flight phase, not just "closing".
    expect(sheetPresentationPhaseAfterEvent("opening", "dismissed")).toBe("closed");
    expect(sheetPresentationPhaseAfterEvent("visible", "dismissed")).toBe("closed");
    expect(sheetPresentationPhaseAfterEvent("closed", "open")).toBe("opening");
  });

  it("treats duplicate dismissal notifications as no-ops", () => {
    // Modal.onDismiss, the Android visibility effect, and the unmount
    // cleanup can all report the same dismissal.
    expect(sheetPresentationPhaseAfterEvent("closing", "dismissed")).toBe("closed");
    expect(sheetPresentationPhaseAfterEvent("closed", "dismissed")).toBeNull();
  });

  it("drops a stale keyboard dismissal after the presentation ended", () => {
    expect(sheetPresentationPhaseAfterEvent("closed", "keyboard-dismissed")).toBeNull();
    expect(sheetPresentationPhaseAfterEvent("closing", "keyboard-dismissed")).toBeNull();
  });

  it("ignores close before open and after closing", () => {
    expect(sheetPresentationPhaseAfterEvent("closed", "close")).toBeNull();
    expect(sheetPresentationPhaseAfterEvent("closing", "close")).toBeNull();
  });
});
