import type { OrchestrationSessionStatus } from "@t3tools/contracts";

import type { RemoteClientConnectionState } from "../../lib/connection";

export function threadComposerSendLabel(input: {
  readonly connectionState: RemoteClientConnectionState;
  readonly queueCount: number;
  readonly sessionStatus: OrchestrationSessionStatus | null;
}): "Queue" | "Send" | "Steer" {
  if (input.sessionStatus === "running" || input.sessionStatus === "starting") {
    return "Steer";
  }
  return input.connectionState !== "connected" || input.queueCount > 0 ? "Queue" : "Send";
}
