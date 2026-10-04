import {
  MESSAGE_SUMMARY_MAX_SOURCE_CHARS,
  MESSAGE_SUMMARY_MAX_TEXT_CHARS,
  ModelSelection,
  ProviderDriverKind,
  type MessageSummaryRequest,
  type MessageSummaryResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { MESSAGE_SUMMARY_RECIPE_HASH, messageArtifactTextHash } from "./identity.ts";
import { makeMessageArtifactLockCoordinator } from "./lock.ts";
import {
  currentArtifactSourceCondition,
  findMessageArtifactSource,
  isUsableArtifactSource,
} from "./source.ts";

interface SummaryRow {
  readonly summary: string;
  readonly sourceTextHash: string;
  readonly recipeHash: string;
  readonly modelSelectionJson: string;
  readonly modelSelectionHash: string;
  readonly createdAt: string;
}

export function withLowSummaryEffort(
  modelSelection: ModelSelection,
  driverKind: ProviderDriverKind,
): ModelSelection {
  const effortOptionId =
    driverKind === ProviderDriverKind.make("codex")
      ? "reasoningEffort"
      : driverKind === ProviderDriverKind.make("claudeAgent")
        ? "effort"
        : driverKind === ProviderDriverKind.make("cursor")
          ? "reasoning"
          : driverKind === ProviderDriverKind.make("opencode")
            ? "variant"
            : null;
  if (effortOptionId === null) return modelSelection;

  return {
    ...modelSelection,
    options: [
      ...(modelSelection.options ?? []).filter((option) => option.id !== effortOptionId),
      { id: effortOptionId, value: "low" },
    ],
  };
}

export class MessageSummaryError extends Schema.TaggedError<MessageSummaryError>()(
  "MessageSummaryError",
  {
    reason: Schema.Literals([
      "message_unavailable",
      "source_too_long",
      "provider_unavailable",
      "generation_failed",
      "storage_failed",
    ]),
  },
) {}

export interface MessageSummaryService {
  readonly summarize: (
    request: MessageSummaryRequest,
  ) => Effect.Effect<MessageSummaryResult, MessageSummaryError>;
}

export class MessageSummary extends Context.Service<MessageSummary, MessageSummaryService>()(
  "t3/messageArtifacts/MessageSummary",
) {}

const storageError = () => new MessageSummaryError({ reason: "storage_failed" });
const decodeModelSelection = Schema.decodeUnknownEffect(Schema.fromJsonString(ModelSelection));

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const textGeneration = yield* TextGeneration;
  const providerInstances = yield* ProviderInstanceRegistry;
  const locks = yield* makeMessageArtifactLockCoordinator();

  const summarizeUnlocked = Effect.fn("MessageSummary.summarizeUnlocked")(function* (
    request: MessageSummaryRequest,
  ) {
    const message = yield* findMessageArtifactSource(sql, request.messageId).pipe(
      Effect.mapError(storageError),
    );
    if (!isUsableArtifactSource(message)) {
      return yield* new MessageSummaryError({ reason: "message_unavailable" });
    }
    const sourceText = message.text.trim();
    if (sourceText.length > MESSAGE_SUMMARY_MAX_SOURCE_CHARS) {
      return yield* new MessageSummaryError({ reason: "source_too_long" });
    }

    const cached = (yield* sql<SummaryRow>`
      SELECT
        summary,
        source_text_hash AS "sourceTextHash",
        recipe_hash AS "recipeHash",
        model_selection_json AS "modelSelectionJson",
        model_selection_hash AS "modelSelectionHash",
        created_at AS "createdAt"
      FROM fork_message_summaries
      WHERE message_id = ${message.messageId}
    `.pipe(Effect.mapError(storageError)))[0];

    // The producing run is the provenance. A runless (imported) message falls
    // back to the thread model once; the summary row pins that choice so later
    // thread model changes neither invalidate nor reinterpret it.
    const provenanceJson =
      message.runModelSelection ?? cached?.modelSelectionJson ?? message.threadModelSelection;
    if (provenanceJson === null) {
      return yield* new MessageSummaryError({ reason: "provider_unavailable" });
    }
    const modelSelection = yield* decodeModelSelection(provenanceJson).pipe(
      Effect.mapError(storageError),
    );
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    const modelSelectionJson = JSON.stringify(modelSelection);
    const sourceTextHash = messageArtifactTextHash(sourceText);
    const modelSelectionHash = messageArtifactTextHash(modelSelectionJson);
    if (
      cached?.sourceTextHash === sourceTextHash &&
      cached.recipeHash === MESSAGE_SUMMARY_RECIPE_HASH &&
      cached.modelSelectionHash === modelSelectionHash
    ) {
      return {
        messageId: request.messageId,
        summary: cached.summary as MessageSummaryResult["summary"],
        createdAt: cached.createdAt as MessageSummaryResult["createdAt"],
      };
    }

    const instance = yield* providerInstances.getInstance(modelSelection.instanceId);
    if (!instance || !instance.enabled) {
      return yield* new MessageSummaryError({ reason: "provider_unavailable" });
    }
    const generated = yield* Effect.scoped(
      Effect.gen(function* () {
        // A thread whose project and worktree are gone still summarizes, from
        // an empty directory.
        const cwd =
          message.cwd ??
          (yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-message-summary-" }));
        return yield* textGeneration.generateMessageSummary({
          cwd,
          message: sourceText,
          maxSummaryChars: MESSAGE_SUMMARY_MAX_TEXT_CHARS,
          modelSelection: withLowSummaryEffort(modelSelection, instance.driverKind),
        });
      }),
    ).pipe(Effect.mapError(() => new MessageSummaryError({ reason: "generation_failed" })));
    const summary = generated.summary.trim();
    if (summary.length === 0 || summary.length > MESSAGE_SUMMARY_MAX_TEXT_CHARS) {
      return yield* new MessageSummaryError({ reason: "generation_failed" });
    }
    const createdAt = DateTime.formatIso(yield* DateTime.now);

    const stored = yield* sql`
      INSERT INTO fork_message_summaries (
        message_id,
        thread_id,
        summary,
        source_text_hash,
        recipe_hash,
        model_selection_json,
        model_selection_hash,
        created_at
      )
      SELECT
        ${message.messageId},
        ${message.threadId},
        ${summary},
        ${sourceTextHash},
        ${MESSAGE_SUMMARY_RECIPE_HASH},
        ${modelSelectionJson},
        ${modelSelectionHash},
        ${createdAt}
      WHERE ${currentArtifactSourceCondition(sql, message)}
      ON CONFLICT(message_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        summary = excluded.summary,
        source_text_hash = excluded.source_text_hash,
        recipe_hash = excluded.recipe_hash,
        model_selection_json = excluded.model_selection_json,
        model_selection_hash = excluded.model_selection_hash,
        created_at = excluded.created_at
      RETURNING message_id
    `.pipe(Effect.mapError(storageError));
    if (stored.length === 0) {
      return yield* new MessageSummaryError({ reason: "message_unavailable" });
    }

    return {
      messageId: request.messageId,
      summary: summary as MessageSummaryResult["summary"],
      createdAt: createdAt as MessageSummaryResult["createdAt"],
    };
  });

  return {
    summarize: (request) => locks.withMessageLock(request.messageId, summarizeUnlocked(request)),
  } satisfies MessageSummaryService;
});

export const layer = Layer.effect(MessageSummary, make);
