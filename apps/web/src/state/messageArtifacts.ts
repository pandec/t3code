import { createMessageSummaryEnvironmentCommand } from "@t3tools/client-runtime/state/messageArtifacts";

import { connectionAtomRuntime } from "../connection/runtime";

export const summarizeMessage = createMessageSummaryEnvironmentCommand(connectionAtomRuntime);
