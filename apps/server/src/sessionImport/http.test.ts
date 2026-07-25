import {
  AuthSessionId,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentSessionImportError,
  ProjectId,
  ProviderInstanceId,
  SessionImportError,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { SessionImportService } from "./SessionImportService.ts";
import { importSessionHttp, listSessionImportCandidatesHttp } from "./http.ts";

const projectId = ProjectId.make("project-http");
const instanceId = ProviderInstanceId.make("claude-http");
const existingThreadId = ThreadId.make("thread-existing");
const decodeEnvironmentSessionImportError = Schema.decodeUnknownEffect(
  EnvironmentSessionImportError,
);

const principalLayer = (scopes: ReadonlyArray<"orchestration:read" | "orchestration:operate">) =>
  Layer.succeed(EnvironmentAuthenticatedPrincipal, {
    sessionId: AuthSessionId.make("session-http"),
    subject: "cli-test",
    method: "bearer-access-token",
    scopes: new Set(scopes),
  });

const serviceLayer = Layer.mock(SessionImportService)({
  listCandidates: () => Effect.succeed([]),
  importSession: () =>
    Effect.fail(
      new SessionImportError({
        reason: "already-imported",
        detail: "already imported",
        existingThreadId,
      }),
    ),
});

it.effect("enforces read versus operate scope on authenticated session-import handlers", () =>
  Effect.gen(function* () {
    const candidates = yield* listSessionImportCandidatesHttp({ projectId }).pipe(
      Effect.provide(Layer.merge(serviceLayer, principalLayer(["orchestration:read"]))),
    );
    expect(candidates).toEqual({ candidates: [] });

    const forbidden = yield* importSessionHttp({
      projectId,
      instanceId,
      nativeSessionId: "native-http",
    }).pipe(
      Effect.provide(Layer.merge(serviceLayer, principalLayer(["orchestration:read"]))),
      Effect.flip,
    );
    expect(forbidden).toMatchObject({
      _tag: "EnvironmentScopeRequiredError",
      requiredScope: "orchestration:operate",
    });
  }),
);

it.effect("decodes extended session-import error payloads with deterministic retry ids", () =>
  Effect.gen(function* () {
    const decoded = yield* decodeEnvironmentSessionImportError({
      _tag: "EnvironmentSessionImportError",
      code: "session_import_error",
      reason: "already-imported",
      detail: "already imported",
      existingThreadId,
    });
    expect(decoded).toMatchObject({
      reason: "already-imported",
      existingThreadId,
    });

    const mapped = yield* importSessionHttp({
      projectId,
      instanceId,
      nativeSessionId: "native-http",
    }).pipe(
      Effect.provide(Layer.merge(serviceLayer, principalLayer(["orchestration:operate"]))),
      Effect.flip,
    );
    expect(mapped).toMatchObject({
      _tag: "EnvironmentSessionImportError",
      reason: "already-imported",
      existingThreadId,
    });
  }),
);
