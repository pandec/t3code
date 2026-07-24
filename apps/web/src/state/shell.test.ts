import {
  AVAILABLE_CONNECTION_STATE,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { isEnvironmentShellReadyForTurnCompletion } from "./shell";

function shellState(status: EnvironmentShellState["status"]): EnvironmentShellState {
  return {
    snapshot: Option.none(),
    status,
    error: Option.none(),
  };
}

function connection(
  patch: Partial<SupervisorConnectionState>,
): Option.Option<SupervisorConnectionState> {
  return Option.some({ ...AVAILABLE_CONNECTION_STATE, ...patch });
}

describe("isEnvironmentShellReadyForTurnCompletion", () => {
  it("waits for an authoritative shell instead of accepting a cache during synchronization", () => {
    expect(
      isEnvironmentShellReadyForTurnCompletion(
        shellState("cached"),
        connection({ desired: true, phase: "connecting", stage: "synchronizing" }),
      ),
    ).toBe(false);
    expect(
      isEnvironmentShellReadyForTurnCompletion(
        shellState("synchronizing"),
        connection({ desired: true, phase: "connected" }),
      ),
    ).toBe(false);
    expect(
      isEnvironmentShellReadyForTurnCompletion(
        shellState("live"),
        connection({ desired: true, phase: "connected" }),
      ),
    ).toBe(true);
  });

  it("waits while connection state is still unknown", () => {
    expect(isEnvironmentShellReadyForTurnCompletion(shellState("cached"), Option.none())).toBe(
      false,
    );
  });

  it("settles disconnected environments after their initial retries", () => {
    expect(
      isEnvironmentShellReadyForTurnCompletion(
        shellState("cached"),
        connection({ desired: true, phase: "backoff", attempt: 2 }),
      ),
    ).toBe(false);
    expect(
      isEnvironmentShellReadyForTurnCompletion(
        shellState("cached"),
        connection({ desired: true, phase: "backoff", attempt: 3 }),
      ),
    ).toBe(true);
  });
});
