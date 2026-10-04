import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentAuthenticatedPrincipal,
  ProjectId,
  ProviderInstanceId,
  SessionImportError,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  forkImportedThreadHttp,
  importSessionHttp,
  listSessionImportCandidatesHttp,
} from "./http.ts";
import { SessionImportService } from "./SessionImportService.ts";

const projectId = ProjectId.make("project-http");
const instanceId = ProviderInstanceId.make("claude-http");
const existingThreadId = ThreadId.make("thread-existing");

const principalLayer = (scopes: ReadonlyArray<"orchestration:read" | "orchestration:operate">) =>
  Layer.succeed(EnvironmentAuthenticatedPrincipal, {
    sessionId: AuthSessionId.make("session-http"),
    subject: "cli-test",
    method: "bearer-access-token",
    scopes: new Set(scopes),
  });

const alreadyImported = new SessionImportError({
  reason: "already-imported",
  detail: "already imported",
  existingThreadId,
});

const serviceLayer = Layer.mock(SessionImportService)({
  listCandidates: () => Effect.succeed([]),
  importSession: () => Effect.fail(alreadyImported),
  forkImportedThread: () => Effect.fail(alreadyImported),
});

it.effect("lists candidates with the read scope but needs operate to create threads", () =>
  Effect.gen(function* () {
    const readOnly = Layer.merge(serviceLayer, principalLayer(["orchestration:read"]));
    const candidates = yield* listSessionImportCandidatesHttp({ projectId }).pipe(
      Effect.provide(readOnly),
    );
    expect(candidates).toEqual({ candidates: [] });

    for (const operate of [
      importSessionHttp({ projectId, instanceId, nativeSessionId: "native-http" }),
      forkImportedThreadHttp({ threadId: existingThreadId }),
    ]) {
      const forbidden = yield* operate.pipe(Effect.provide(readOnly), Effect.flip);
      expect(forbidden).toMatchObject({
        _tag: "EnvironmentScopeRequiredError",
        requiredScope: "orchestration:operate",
      });
    }
  }),
);

it.effect("maps service failures to the HTTP error envelope with the existing thread id", () =>
  Effect.gen(function* () {
    const operate = Layer.merge(serviceLayer, principalLayer(["orchestration:operate"]));
    for (const request of [
      importSessionHttp({ projectId, instanceId, nativeSessionId: "native-http" }),
      forkImportedThreadHttp({ threadId: existingThreadId }),
    ]) {
      const error = yield* request.pipe(Effect.provide(operate), Effect.flip);
      expect(error).toMatchObject({
        _tag: "EnvironmentSessionImportError",
        code: "session_import_error",
        reason: "already-imported",
        detail: "already imported",
        existingThreadId,
      });
    }
  }),
);
