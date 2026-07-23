/**
 * CodexImportReader — performs workspace-scoped reads through an ephemeral
 * `codex app-server` process: skills plus externally created CLI sessions.
 * No rollout file parsing.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";
import type { ServerProviderSkill } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { expandHomePath } from "../../pathExpansion.ts";
import {
  buildCodexInitializeParams,
  parseCodexSkillsListResponse,
} from "../Layers/CodexProvider.ts";

export class CodexImportReaderError extends Schema.TaggedErrorClass<CodexImportReaderError>()(
  "CodexImportReaderError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const APP_SERVER_FORCE_KILL_AFTER = "2 seconds" as const;
const LIST_PAGE_SIZE = 50;
const LIST_MAX_PAGES = 20;

export interface CodexImportReaderOptions {
  readonly binaryPath: string;
  readonly homePath?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly cwd: string;
}

export interface CodexImportableSessionSummary {
  readonly threadId: string;
  /** User-assigned thread name (`/rename` in the CLI). */
  readonly name: string | null;
  readonly preview: string;
  readonly updatedAt: string;
}

export interface CodexImportedMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export interface CodexImportedThread {
  readonly threadId: string;
  readonly cwd: string;
  readonly name: string | null;
  readonly messages: ReadonlyArray<CodexImportedMessage>;
}

type CodexAppServerClientService = CodexClient.CodexAppServerClient["Service"];

const unixSecondsToIso = (seconds: number | null | undefined, fallback: string): string =>
  typeof seconds === "number"
    ? DateTime.make(seconds * 1000).pipe(
        Option.match({ onNone: () => fallback, onSome: DateTime.formatIso }),
      )
    : fallback;

const toReaderError = (detail: string) => (cause: unknown) =>
  new CodexImportReaderError({ detail, cause });

/**
 * Spawn a scoped ephemeral `codex app-server`, run `use` against its
 * initialized JSON-RPC client, then shut the process down with the scope.
 */
const withCodexAppServerClient = <A, E>(
  options: CodexImportReaderOptions,
  use: (client: CodexAppServerClientService) => Effect.Effect<A, E>,
) =>
  Effect.scopedWith((scope) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const resolvedHomePath = options.homePath ? expandHomePath(options.homePath) : undefined;
      const env = {
        ...(options.environment ?? process.env),
        ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
      };
      const spawnCommand = yield* resolveSpawnCommand(options.binaryPath, ["app-server"], {
        env,
        extendEnv: false,
      }).pipe(Effect.mapError(toReaderError("Failed to resolve the Codex app-server command.")));
      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            cwd: options.cwd,
            env,
            extendEnv: false,
            forceKillAfter: APP_SERVER_FORCE_KILL_AFTER,
            shell: spawnCommand.shell,
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError(toReaderError("Failed to spawn the Codex app-server process.")),
        );
      const clientContext = yield* CodexClient.layerChildProcess(child).pipe(
        Layer.build,
        Effect.provideService(Scope.Scope, scope),
      );
      const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
        Effect.provide(clientContext),
      );
      yield* client
        .request("initialize", buildCodexInitializeParams())
        .pipe(Effect.mapError(toReaderError("Codex app-server initialize failed.")));
      yield* client
        .notify("initialized", undefined)
        .pipe(Effect.mapError(toReaderError("Codex app-server initialized notify failed.")));
      return yield* use(client);
    }),
  );

/**
 * List external interactive-CLI Codex sessions for a workspace root,
 * following `nextCursor` pagination with a safety cap.
 */
export const listCodexImportableSessions = Effect.fn("listCodexImportableSessions")(function* (
  options: CodexImportReaderOptions,
) {
  return yield* withCodexAppServerClient(options, (client) =>
    Effect.gen(function* () {
      const summaries: Array<CodexImportableSessionSummary> = [];
      let cursor: string | undefined;
      for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
        const response = yield* client
          .request("thread/list", {
            cwd: options.cwd,
            sourceKinds: ["cli"],
            limit: LIST_PAGE_SIZE,
            ...(cursor !== undefined ? { cursor } : {}),
          })
          .pipe(Effect.mapError(toReaderError("Codex thread/list request failed.")));
        for (const thread of response.data) {
          summaries.push({
            threadId: thread.id,
            name: thread.name ?? null,
            preview: thread.preview,
            updatedAt: unixSecondsToIso(thread.updatedAt, unixSecondsToIso(thread.createdAt, "")),
          });
        }
        if (response.nextCursor === null || response.nextCursor === undefined) {
          return summaries;
        }
        cursor = response.nextCursor;
      }
      yield* Effect.logWarning(
        "Codex importable session listing hit the pagination safety cap; older sessions were omitted.",
        { pages: LIST_MAX_PAGES, pageSize: LIST_PAGE_SIZE },
      );
      return summaries;
    }),
  );
});

export const listCodexSkills = Effect.fn("listCodexSkills")(function* (
  options: CodexImportReaderOptions,
): Effect.fn.Return<
  ReadonlyArray<ServerProviderSkill>,
  CodexImportReaderError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return yield* withCodexAppServerClient(options, (client) =>
    client.request("skills/list", { cwds: [options.cwd] }).pipe(
      Effect.map((response) => parseCodexSkillsListResponse(response, options.cwd)),
      Effect.mapError(toReaderError("Codex skills/list request failed.")),
    ),
  );
});

/**
 * Read one external Codex session's user/assistant message history.
 */
export const readCodexImportableThread = Effect.fn("readCodexImportableThread")(function* (
  options: CodexImportReaderOptions & { readonly threadId: string },
) {
  return yield* withCodexAppServerClient(options, (client) =>
    Effect.gen(function* () {
      const response = yield* client
        .request("thread/read", { threadId: options.threadId, includeTurns: true })
        .pipe(Effect.mapError(toReaderError("Codex thread/read request failed.")));
      const thread = response.thread;
      const threadCreatedAt = unixSecondsToIso(thread.createdAt, "");
      const messages: Array<CodexImportedMessage> = [];
      for (const turn of thread.turns) {
        const turnCreatedAt = unixSecondsToIso(turn.startedAt, threadCreatedAt);
        const turnCompletedAt = unixSecondsToIso(turn.completedAt, turnCreatedAt);
        for (const item of turn.items) {
          if (item.type === "userMessage") {
            const text = item.content
              .filter((input): input is Extract<typeof input, { text: string }> => "text" in input)
              .map((input) => input.text)
              .join("\n");
            if (text.trim().length > 0) {
              messages.push({ role: "user", text, createdAt: turnCreatedAt });
            }
            continue;
          }
          if (item.type === "agentMessage") {
            if (item.text.trim().length > 0) {
              messages.push({ role: "assistant", text: item.text, createdAt: turnCompletedAt });
            }
          }
        }
      }
      return {
        threadId: thread.id,
        cwd: thread.cwd,
        name: thread.name ?? null,
        messages,
      } satisfies CodexImportedThread;
    }),
  );
});
