import {
  MESSAGE_SUMMARY_MAX_SOURCE_CHARS,
  MESSAGE_SUMMARY_MAX_TEXT_CHARS,
  ModelSelection,
  ProviderDriverKind,
  type MessageSummaryRequest,
  type MessageSummaryResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { makeMessageArtifactLockCoordinator } from "./lock.ts";
import { MESSAGE_SUMMARY_RECIPE_HASH, messageArtifactTextHash } from "./identity.ts";

interface SummaryRow {
  readonly messageId: string;
  readonly threadId: string;
  readonly summary: string;
  readonly sourceTextHash: string;
  readonly recipeHash: string;
  readonly modelSelectionHash: string;
  readonly createdAt: string;
}

interface AssistantMessageContextRow {
  readonly messageId: string;
  readonly threadId: string;
  readonly role: string;
  readonly text: string;
  readonly isStreaming: number;
  readonly modelSelection: string;
  readonly cwd: string;
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

export class MessageSummaryError extends Schema.TaggedErrorClass<MessageSummaryError>()(
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
  const textGeneration = yield* TextGeneration;
  const providerInstances = yield* ProviderInstanceRegistry;
  const locks = yield* makeMessageArtifactLockCoordinator();

  const summarizeUnlocked = Effect.fn("MessageSummary.summarizeUnlocked")(function* (
    request: MessageSummaryRequest,
  ) {
    const messageRows = yield* sql<AssistantMessageContextRow>`
        SELECT
          messages.message_id AS "messageId",
          messages.thread_id AS "threadId",
          messages.role,
          messages.text,
          messages.is_streaming AS "isStreaming",
          COALESCE(
            messages.generation_model_selection_json,
            -- Legacy/imported messages can lack authoritative provenance.
            -- Falling back at request time is intentionally best-effort and
            -- never persisted as immutable historical context.
            threads.model_selection_json
          ) AS "modelSelection",
          COALESCE(
            messages.generation_cwd,
            threads.worktree_path,
            projects.workspace_root
          ) AS cwd
        FROM projection_thread_messages AS messages
        INNER JOIN projection_threads AS threads
          ON threads.thread_id = messages.thread_id
          AND threads.deleted_at IS NULL
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
          AND projects.deleted_at IS NULL
        WHERE messages.message_id = ${request.messageId}
        LIMIT 1
      `.pipe(Effect.mapError(storageError));
    const message = messageRows[0];
    const sourceText = message?.text.trim() ?? "";
    if (
      !message ||
      message.role !== "assistant" ||
      message.isStreaming !== 0 ||
      sourceText.length === 0
    ) {
      return yield* new MessageSummaryError({ reason: "message_unavailable" });
    }
    if (sourceText.length > MESSAGE_SUMMARY_MAX_SOURCE_CHARS) {
      return yield* new MessageSummaryError({ reason: "source_too_long" });
    }

    const modelSelection = yield* decodeModelSelection(message.modelSelection).pipe(
      Effect.mapError(storageError),
    );
    const instance = yield* providerInstances.getInstance(modelSelection.instanceId);
    if (!instance || !instance.enabled) {
      return yield* new MessageSummaryError({ reason: "provider_unavailable" });
    }
    const summaryModelSelection = withLowSummaryEffort(modelSelection, instance.driverKind);
    // Once a legacy message is summarized, pin the best-effort fallback used
    // for this request. Later thread model/worktree changes must not reinterpret
    // either the persisted summary or future regenerations.
    yield* sql`
      UPDATE projection_thread_messages
      SET
        generation_model_selection_json = COALESCE(
          generation_model_selection_json,
          ${message.modelSelection}
        ),
        generation_cwd = COALESCE(generation_cwd, ${message.cwd})
      WHERE message_id = ${message.messageId}
    `.pipe(Effect.mapError(storageError));
    const sourceTextHash = messageArtifactTextHash(sourceText);
    const recipeHash = MESSAGE_SUMMARY_RECIPE_HASH;
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    const modelSelectionHash = messageArtifactTextHash(JSON.stringify(summaryModelSelection));

    const cachedRows = yield* sql<SummaryRow>`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          summary,
          source_text_hash AS "sourceTextHash",
          recipe_hash AS "recipeHash",
          model_selection_hash AS "modelSelectionHash",
          created_at AS "createdAt"
        FROM projection_message_summary
        WHERE message_id = ${message.messageId}
        LIMIT 1
      `.pipe(Effect.mapError(storageError));
    const cached = cachedRows[0];
    if (
      cached?.sourceTextHash === sourceTextHash &&
      cached.recipeHash === recipeHash &&
      cached.modelSelectionHash === modelSelectionHash
    ) {
      return {
        messageId: request.messageId,
        summary: cached.summary as MessageSummaryResult["summary"],
        createdAt: cached.createdAt as MessageSummaryResult["createdAt"],
      };
    }

    const generated = yield* textGeneration
      .generateMessageSummary({
        cwd: message.cwd,
        message: sourceText,
        maxSummaryChars: MESSAGE_SUMMARY_MAX_TEXT_CHARS,
        modelSelection: summaryModelSelection,
      })
      .pipe(Effect.mapError(() => new MessageSummaryError({ reason: "generation_failed" })));
    const summary = generated.summary.trim();
    if (summary.length === 0 || summary.length > MESSAGE_SUMMARY_MAX_TEXT_CHARS) {
      return yield* new MessageSummaryError({ reason: "generation_failed" });
    }
    const createdAt = DateTime.formatIso(yield* DateTime.now);

    const rows = yield* sql<SummaryRow>`
        INSERT INTO projection_message_summary (
          message_id,
          thread_id,
          summary,
          source_text_hash,
          recipe_hash,
          model_selection_hash,
          created_at
        )
        SELECT
          ${message.messageId},
          ${message.threadId},
          ${summary},
          ${sourceTextHash},
          ${recipeHash},
          ${modelSelectionHash},
          ${createdAt}
        WHERE EXISTS (
          SELECT 1
          FROM projection_thread_messages AS messages
          INNER JOIN projection_threads AS threads
            ON threads.thread_id = messages.thread_id
            AND threads.deleted_at IS NULL
          WHERE messages.message_id = ${message.messageId}
            AND messages.thread_id = ${message.threadId}
            AND messages.role = 'assistant'
            AND messages.is_streaming = 0
            AND messages.text = ${message.text}
        )
        ON CONFLICT(message_id) DO UPDATE SET
          thread_id = excluded.thread_id,
          summary = excluded.summary,
          source_text_hash = excluded.source_text_hash,
          recipe_hash = excluded.recipe_hash,
          model_selection_hash = excluded.model_selection_hash,
          created_at = excluded.created_at
        RETURNING
          message_id AS "messageId",
          thread_id AS "threadId",
          summary,
          source_text_hash AS "sourceTextHash",
          recipe_hash AS "recipeHash",
          model_selection_hash AS "modelSelectionHash",
          created_at AS "createdAt"
      `.pipe(Effect.mapError(storageError));
    if (rows.length === 0) {
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
