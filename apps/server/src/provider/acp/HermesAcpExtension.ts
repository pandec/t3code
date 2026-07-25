import type { RuntimeMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import type { AcpToolCallState } from "./AcpRuntimeModel.ts";

export const HermesSetModeResponse = Schema.Record(Schema.String, Schema.Never);
const decodeHermesSetModeResponse = Schema.decodeUnknownEffect(HermesSetModeResponse);

export function hermesModeIdForRuntimeMode(runtimeMode: RuntimeMode): "default" | "dont_ask" {
  return runtimeMode === "full-access" ? "dont_ask" : "default";
}

export function decodeHermesSetModeResult(
  input: unknown,
): Effect.Effect<{}, EffectAcpErrors.AcpRequestError> {
  return decodeHermesSetModeResponse(input).pipe(
    Effect.mapError((cause) =>
      EffectAcpErrors.AcpRequestError.invalidExtensionPayload("session/set_mode", cause),
    ),
  );
}

export function isPrunedHermesSessionLoad(input: {
  readonly resumeSessionId: string | undefined;
  readonly replayUpdateCount: number;
  readonly sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse;
}): boolean {
  return (
    input.resumeSessionId !== undefined &&
    input.replayUpdateCount === 0 &&
    input.sessionSetupResult.models == null &&
    input.sessionSetupResult.modes == null
  );
}

export function updateHermesOpenToolCalls(
  openToolCalls: ReadonlyMap<string, AcpToolCallState>,
  toolCall: AcpToolCallState,
): ReadonlyMap<string, AcpToolCallState> {
  const next = new Map(openToolCalls);
  if (toolCall.status === "completed" || toolCall.status === "failed") {
    next.delete(toolCall.toolCallId);
  } else {
    next.set(toolCall.toolCallId, toolCall);
  }
  return next;
}

export function settleHermesOpenToolCalls(
  openToolCalls: ReadonlyMap<string, AcpToolCallState>,
): ReadonlyArray<AcpToolCallState> {
  return Array.from(openToolCalls.values(), (toolCall) => ({
    ...toolCall,
    status: "completed" as const,
  }));
}
