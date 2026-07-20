import type { ProviderInstanceId, ServerProviderSkillsResult } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { AUTH_PROBE_TIMEOUT_MS } from "./providerSnapshot.ts";
import type { ProviderInstanceRegistryShape } from "./Services/ProviderInstanceRegistry.ts";

/**
 * Discovery spawns an ephemeral `codex app-server` per request, so it pays the
 * same cold-start cost as the startup snapshot probe. Reuse that budget rather
 * than a tighter one: timing out here silently degrades to the server-cwd
 * snapshot skills, which is exactly the behaviour this lookup exists to avoid.
 */
const SKILL_LIST_TIMEOUT = Duration.millis(AUTH_PROBE_TIMEOUT_MS);

export const listProviderSkillsForCwd = Effect.fn("listProviderSkillsForCwd")(function* (
  registry: Pick<ProviderInstanceRegistryShape, "getInstance">,
  input: { readonly instanceId: ProviderInstanceId; readonly cwd: string },
) {
  const instance = yield* registry.getInstance(input.instanceId);
  if (instance === undefined) {
    return { skills: [] } satisfies ServerProviderSkillsResult;
  }

  const snapshot = yield* instance.snapshot.getSnapshot;
  if (!instance.enabled || instance.adapter.listSkills === undefined) {
    return { skills: snapshot.skills } satisfies ServerProviderSkillsResult;
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
