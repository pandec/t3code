import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  EnvironmentAuthenticatedPrincipal,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "./ProviderDriver.ts";
import { ProviderInstanceRegistry } from "./Services/ProviderInstanceRegistry.ts";
import { getProviderCatalogHttp, providerImportHome } from "./http.ts";

const instanceId = ProviderInstanceId.make("claude-work");
const instance = {
  instanceId,
  driverKind: ProviderDriverKind.make("claudeAgent"),
  continuationIdentity: {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    continuationKey: "claude:home:/Users/test/.claude",
  },
  displayName: "Claude Work",
  enabled: true,
  snapshot: {
    getSnapshot: Effect.succeed({
      displayName: "Claude Work",
      models: [
        {
          slug: "claude-sonnet-5",
          name: "Sonnet",
          isCustom: false,
          capabilities: { optionDescriptors: [] },
        },
      ],
    }),
  },
  adapter: {
    listImportableSessions: () => Effect.succeed([]),
    readImportableSession: () => Effect.die("unused"),
  },
} as unknown as ProviderInstance;

const registryLayer = Layer.mock(ProviderInstanceRegistry)({
  getInstance: () => Effect.succeed(instance),
  listInstances: Effect.succeed([instance]),
  listUnavailable: Effect.succeed([]),
  streamChanges: Stream.empty,
});

const principalLayer = (scopes: ReadonlyArray<"orchestration:read">) =>
  Layer.succeed(EnvironmentAuthenticatedPrincipal, {
    sessionId: AuthSessionId.make("session-provider-http"),
    subject: "cli-test",
    method: "bearer-access-token",
    scopes: new Set(scopes),
  });

it.layer(NodeServices.layer)("provider catalog HTTP handler", (it) => {
  it.effect("requires read scope and returns import metadata without credentials", () =>
    Effect.gen(function* () {
      const forbidden = yield* getProviderCatalogHttp().pipe(
        Effect.provide(Layer.merge(registryLayer, principalLayer([]))),
        Effect.flip,
      );
      expect(forbidden).toMatchObject({
        _tag: "EnvironmentScopeRequiredError",
        requiredScope: "orchestration:read",
      });

      const catalog = yield* getProviderCatalogHttp().pipe(
        Effect.provide(Layer.merge(registryLayer, principalLayer(["orchestration:read"]))),
      );
      expect(catalog.instances).toEqual([
        {
          instanceId,
          driverKind: "claudeAgent",
          displayName: "Claude Work",
          enabled: true,
          importCapable: true,
          home: "/Users/test/.claude",
          models: [
            {
              slug: "claude-sonnet-5",
              name: "Sonnet",
              optionDescriptors: [],
            },
          ],
        },
      ]);
    }),
  );
});

it.layer(NodeServices.layer)("provider import homes", (it) => {
  it("keeps a custom Claude config directory direct", () => {
    expect(
      providerImportHome({
        ...instance,
        continuationIdentity: {
          driverKind: ProviderDriverKind.make("claudeAgent"),
          continuationKey: "claude:home:/Users/test/.claude-work",
        },
      }),
    ).toBe("/Users/test/.claude-work");
  });
});
