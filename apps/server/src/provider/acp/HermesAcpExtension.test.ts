import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  decodeHermesSetModeResult,
  hermesModeIdForRuntimeMode,
  isPrunedHermesSessionLoad,
  settleHermesOpenToolCalls,
  updateHermesOpenToolCalls,
} from "./HermesAcpExtension.ts";

describe("HermesAcpExtension", () => {
  it("maps only full access to dont_ask", () => {
    expect(hermesModeIdForRuntimeMode("full-access")).toBe("dont_ask");
    expect(hermesModeIdForRuntimeMode("approval-required")).toBe("default");
    expect(hermesModeIdForRuntimeMode("auto-accept-edits")).toBe("default");
    expect(hermesModeIdForRuntimeMode("auto")).toBe("default");
  });

  it.effect("validates the empty session/set_mode response locally", () =>
    Effect.gen(function* () {
      expect(yield* decodeHermesSetModeResult({})).toEqual({});
      const result = yield* decodeHermesSetModeResult("invalid").pipe(
        Effect.match({
          onFailure: (error) => error._tag,
          onSuccess: () => "success",
        }),
      );
      expect(result).toBe("AcpRequestError");
    }),
  );

  it("detects only an empty, replay-free resumed load as pruned", () => {
    expect(
      isPrunedHermesSessionLoad({
        resumeSessionId: "missing",
        replayUpdateCount: 0,
        sessionSetupResult: {},
      }),
    ).toBe(true);
    expect(
      isPrunedHermesSessionLoad({
        resumeSessionId: "live",
        replayUpdateCount: 1,
        sessionSetupResult: {},
      }),
    ).toBe(false);
    expect(
      isPrunedHermesSessionLoad({
        resumeSessionId: "live",
        replayUpdateCount: 0,
        sessionSetupResult: {
          modes: { currentModeId: "default", availableModes: [] },
        },
      }),
    ).toBe(false);
  });

  it("tracks and settles pending Hermes tool calls", () => {
    const pending = {
      toolCallId: "tool-1",
      title: "Shell",
      kind: "execute" as const,
      status: "inProgress" as const,
      data: {},
    };
    const open = updateHermesOpenToolCalls(new Map(), pending);
    expect(settleHermesOpenToolCalls(open)).toEqual([{ ...pending, status: "completed" }]);
    expect(updateHermesOpenToolCalls(open, { ...pending, status: "failed" }).size).toBe(0);
  });
});
