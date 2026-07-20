import type { ProviderInstanceId, ServerProviderSkillsResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import type { ProviderInstanceRegistryShape } from "./Services/ProviderInstanceRegistry.ts";

const SKILL_LIST_TIMEOUT = "5 seconds" as const;

export const listProviderSkillsForCwd = Effect.fn("listProviderSkillsForCwd")(function* (
  registry: Pick<ProviderInstanceRegistryShape, "getInstance">,
  input: { readonly instanceId: ProviderInstanceId; readonly cwd: string },
) {
  const instance = yield* registry.getInstance(input.instanceId);
  if (instance === undefined) {
    return { skills: [] };
  }

  const snapshot = yield* instance.snapshot.getSnapshot;
  if (!instance.enabled || instance.adapter.listSkills === undefined) {
    return { skills: snapshot.skills };
  }

  const result = yield* instance.adapter
    .listSkills({ cwd: input.cwd })
    .pipe(Effect.timeoutOption(SKILL_LIST_TIMEOUT), Effect.result);

  if (Result.isSuccess(result) && Option.isSome(result.success)) {
    return { skills: result.success.value } satisfies ServerProviderSkillsResult;
  }

  yield* Effect.logWarning("Failed to list provider skills for workspace; using snapshot skills.", {
    instanceId: input.instanceId,
    cwd: input.cwd,
    ...(Result.isFailure(result) ? { cause: result.failure } : { cause: "request timed out" }),
  });
  return { skills: snapshot.skills } satisfies ServerProviderSkillsResult;
});
