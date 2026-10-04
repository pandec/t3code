import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { buildProviderCatalog } from "./http.ts";
import type { ProviderInstance } from "./ProviderDriver.ts";

const instance = (input: {
  readonly id: string;
  readonly driver: string;
  readonly continuationKey: string;
  readonly importable: boolean;
}) =>
  ({
    instanceId: ProviderInstanceId.make(input.id),
    driverKind: ProviderDriverKind.make(input.driver),
    continuationIdentity: {
      driverKind: ProviderDriverKind.make(input.driver),
      continuationKey: input.continuationKey,
    },
    displayName: undefined,
    enabled: true,
    snapshot: { getSnapshot: Effect.succeed({ displayName: input.driver, models: [] }) },
    ...(input.importable ? { sessionImport: {} } : {}),
  }) as unknown as ProviderInstance;

it.effect("marks only instances with one static session home as import capable", () =>
  Effect.gen(function* () {
    const catalog = yield* buildProviderCatalog([
      instance({
        id: "claude",
        driver: "claudeAgent",
        continuationKey: "claude:home:/home/user/.claude",
        importable: true,
      }),
      instance({
        id: "claude_relative",
        driver: "claudeAgent",
        continuationKey: "claude:relative-config:.claude-work",
        importable: true,
      }),
      instance({
        id: "codex",
        driver: "codex",
        continuationKey: "codex:home:/home/user/.codex",
        importable: true,
      }),
      instance({
        id: "cursor",
        driver: "cursor",
        continuationKey: "cursor:instance:cursor",
        importable: false,
      }),
    ]);
    assert.deepEqual(
      catalog.instances.map((entry) => [entry.instanceId, entry.importCapable, entry.home]),
      [
        ["claude", true, "/home/user/.claude"],
        ["claude_relative", false, undefined],
        ["codex", true, "/home/user/.codex"],
        ["cursor", false, undefined],
      ],
    );
  }),
);
