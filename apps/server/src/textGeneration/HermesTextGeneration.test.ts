// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { HermesSettings, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { execScriptSource, writeFakeCli } from "../testUtils/fakeCli.ts";
import { makeHermesTextGeneration } from "./HermesTextGeneration.ts";

it.layer(NodeServices.layer)("Hermes thread titles", (it) => {
  it.effect("includes linked context and preserves the refinement request", () =>
    Effect.gen(function* () {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hermes-title-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      const requestLogPath = NodePath.join(directory, "requests.ndjson");
      const binaryPath = writeFakeCli({
        directory,
        name: "hermes",
        env: {
          T3_ACP_USE_HERMES_MODES: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_PROMPT_RESPONSE_TEXT: '{"title":"Investigate CI","needsRefinement":true}',
        },
        source: execScriptSource({
          scriptPath: NodeURL.fileURLToPath(
            new URL("../../scripts/acp-mock-agent.ts", import.meta.url),
          ),
          expectedArgs: ["acp"],
        }),
      });
      const generation = yield* makeHermesTextGeneration(
        yield* Schema.decodeEffect(HermesSettings)({ binaryPath }),
      );
      const result = yield* generation.generateThreadTitle({
        cwd: directory,
        message: "Fix this issue",
        linkedContext: "Issue 42: CI fails after reconnect",
        modelSelection: createModelSelection(ProviderInstanceId.make("hermes"), "default"),
      });
      expect(result).toEqual({ title: "Investigate CI", needsRefinement: true });
      expect(NodeFS.readFileSync(requestLogPath, "utf8")).toContain(
        "Issue 42: CI fails after reconnect",
      );
    }).pipe(Effect.scoped),
  );
});
