import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/unstable/reactivity";

import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/**
 * Linear issue reads and the comment writer. The server caches each read for a minute, so a
 * tighter staleness would only re-read cache; the panel's refresh button passes `refresh: true`
 * through to bust it.
 */
export function createLinearEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // Bumped when an environment's API key changes: a new key may belong to another workspace, so
  // every issue and comment read on that environment is stale along with the status.
  const keyGeneration = Atom.family((environmentId: string) =>
    Atom.make(0).pipe(Atom.withLabel(`environment-data:linear:key-generation:${environmentId}`)),
  );
  const status = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:linear:status",
    tag: WS_METHODS.linearStatus,
    staleTimeMs: 60_000,
    refreshTrigger: ({ environmentId }) => keyGeneration(environmentId),
  });
  const issue = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:linear:issue",
    tag: WS_METHODS.linearIssue,
    staleTimeMs: 60_000,
    refreshTrigger: ({ environmentId }) => keyGeneration(environmentId),
  });
  const comments = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:linear:comments",
    tag: WS_METHODS.linearComments,
    staleTimeMs: 60_000,
    refreshTrigger: ({ environmentId }) => keyGeneration(environmentId),
  });
  return {
    status,
    issue,
    comments,
    configure: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:linear:configure",
      tag: WS_METHODS.linearConfigure,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => {
          const generation = keyGeneration(environmentId);
          registry.set(generation, registry.get(generation) + 1);
        }),
    }),
    createComment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:linear:create-comment",
      tag: WS_METHODS.linearCreateComment,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => `${environmentId}:${input.issueId}`,
      },
    }),
  };
}
