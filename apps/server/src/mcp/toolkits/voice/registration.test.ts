import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as ServerConfig from "../../../config.ts";
import * as DeviceService from "../../../device/DeviceService.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as VcsStatusBroadcaster from "../../../vcs/VcsStatusBroadcaster.ts";
import * as AgentVoiceReply from "../../../voice/AgentVoiceReply.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import type { McpCapability } from "../../McpInvocationContext.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";

const StubServicesLive = Layer.mergeAll(
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
  Layer.mock(DeviceService.DeviceService)({}),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  ServerSettings.layerTest({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
);

const threadId = ThreadId.make("thread-voice-mcp");

/** Speaks JSON-RPC to the island the credential's endpoint names. */
const mcpSession = (capabilities: ReadonlySet<McpCapability>) =>
  Effect.gen(function* () {
    const credential = yield* McpSessionRegistry.issueActiveMcpCredential({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      capabilities,
    });
    const path = new URL(credential!.config.endpoint).pathname;
    const httpClient = yield* HttpClient.HttpClient;
    const headers = {
      accept: "application/json, text/event-stream",
      authorization: credential!.config.authorizationHeader,
    };
    const init = yield* httpClient.post(path, {
      headers,
      body: HttpBody.text(
        `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"voice","version":"1.0.0"}}}`,
        "application/json",
      ),
    });
    const sessionId = init.headers["mcp-session-id"];
    const call = (id: number, method: string, params: unknown) =>
      httpClient
        .post(path, {
          headers: {
            ...headers,
            "mcp-protocol-version": "2025-06-18",
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
          },
          body: HttpBody.text(
            JSON.stringify({ jsonrpc: "2.0", id, method, params }),
            "application/json",
          ),
        })
        .pipe(Effect.flatMap((response) => response.text));
    return { path, call };
  });

const toolNames = (body: string): ReadonlyArray<string> => {
  const payload = JSON.parse(body.match(/\{.*\}/s)![0]) as {
    readonly result: { readonly tools: ReadonlyArray<{ readonly name: string }> };
  };
  return payload.result.tools.map((tool) => tool.name);
};

it.effect("voice_reply exists only for credentials with the voice capability", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const staged = yield* Ref.make<ReadonlyArray<string>>([]);
      const voiceStub = Layer.mock(AgentVoiceReply.AgentVoiceReply)({
        stage: (input) =>
          Ref.update(staged, (current) => [...current, `${input.threadId}:${input.script}`]).pipe(
            Effect.as({ status: "staged" as const, transcriptChars: 5, audioSizeBytes: 10 }),
          ),
      });
      const routes = McpHttpServer.layer.pipe(Layer.provide(McpSessionRegistry.layer));
      yield* HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.provide(
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed("environment-voice" as never),
          }),
        ),
        Layer.provide(PreviewAutomationBroker.layer),
        Layer.provide(Layer.merge(StubServicesLive, voiceStub)),
        Layer.build,
      );

      for (const capabilities of [
        new Set<McpCapability>(["voice"]),
        new Set<McpCapability>(["voice", "preview"]),
        new Set<McpCapability>(["voice", "device"]),
        new Set<McpCapability>(["voice", "preview", "device"]),
      ]) {
        const session = yield* mcpSession(capabilities);
        expect(toolNames(yield* session.call(2, "tools/list", {})), session.path).toContain(
          "voice_reply",
        );
      }
      for (const capabilities of [
        new Set<McpCapability>(),
        new Set<McpCapability>(["preview"]),
        new Set<McpCapability>(["device"]),
        new Set<McpCapability>(["preview", "device"]),
      ]) {
        const session = yield* mcpSession(capabilities);
        expect(toolNames(yield* session.call(2, "tools/list", {})), session.path).not.toContain(
          "voice_reply",
        );
      }

      // The call stages for the credential's own thread.
      const voice = yield* mcpSession(new Set<McpCapability>(["voice"]));
      const result = yield* voice.call(3, "tools/call", {
        name: "voice_reply",
        arguments: { script: "Hello." },
      });
      expect(result).toContain("staged");
      expect(yield* Ref.get(staged)).toEqual([`${threadId}:Hello.`]);
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeHttpServer.layerTest,
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-voice-mcp-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
        NodeServices.layer,
      ),
    ),
  ),
);
