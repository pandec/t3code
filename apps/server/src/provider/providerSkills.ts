import type { ProviderInstanceId, ServerProviderSkillsResult } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { AUTH_PROBE_TIMEOUT_MS } from "./providerSnapshot.ts";
import type { ProviderInstanceRegistryShape } from "./Services/ProviderInstanceRegistry.ts";
import type { ProviderRegistryShape } from "./Services/ProviderRegistry.ts";

export const listProviderSkillsForCwd = Effect.fn("listProviderSkillsForCwd")(function* (
  instanceRegistry: Pick<ProviderInstanceRegistryShape, "getInstance">,
  providerRegistry: Pick<ProviderRegistryShape, "refreshWorkspaceSnapshot">,
  input: { readonly instanceId: ProviderInstanceId; readonly cwd: string },
) {
  const instance = yield* instanceRegistry.getInstance(input.instanceId);
  if (instance === undefined) {
    // Callers cannot tell this apart from "this provider has no skills", so
    // say so in the log; the client keeps showing its own snapshot skills.
    yield* Effect.logWarning("Cannot list provider skills for an unknown instance.", {
      instanceId: input.instanceId,
      cwd: input.cwd,
    });
    return { skills: [] } satisfies ServerProviderSkillsResult;
  }

  const snapshot = yield* instance.snapshot.getSnapshot;

  // Providers with a workspace-scoped snapshot probe (Codex, OpenCode) answer
  // through the machine registry: its per-cwd cache is authoritative once
  // populated, and its claim-based dedupe means this RPC and the client's
  // provider-refresh path share one probe instead of launching two app
  // servers. When no per-cwd snapshot is available (probe failed, still in
  // flight under another claim, or not yet cached), fall back to machine
  // skills — the same fallback the client's own status resolution uses.
  if (instance.enabled && instance.snapshotForCwd !== undefined) {
    const providers = yield* providerRegistry.refreshWorkspaceSnapshot(input);
    const provider = providers.find((candidate) => candidate.instanceId === input.instanceId);
    const workspace = provider?.workspaceSnapshots?.find((entry) => entry.cwd === input.cwd);
    if (workspace !== undefined) {
      return { skills: workspace.skills } satisfies ServerProviderSkillsResult;
    }
    return { skills: provider?.skills ?? snapshot.skills } satisfies ServerProviderSkillsResult;
  }

  if (instance.enabled && instance.adapter.listSkills !== undefined) {
    const result = yield* instance.adapter
      .listSkills({ cwd: input.cwd })
      .pipe(
        Effect.timeoutOption(
          Duration.millis(instance.adapter.listSkillsTimeoutMillis ?? AUTH_PROBE_TIMEOUT_MS),
        ),
        Effect.result,
      );

    if (Result.isSuccess(result) && Option.isSome(result.success)) {
      return { skills: result.success.value } satisfies ServerProviderSkillsResult;
    }

    yield* Effect.logWarning(
      "Failed to list provider skills for workspace; using snapshot skills.",
      {
        instanceId: input.instanceId,
        cwd: input.cwd,
        ...(Result.isFailure(result) ? { cause: result.failure } : { cause: "request timed out" }),
      },
    );
  }

  return { skills: snapshot.skills } satisfies ServerProviderSkillsResult;
});
