import type { MessageId, ModelSelection } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import {
  getMessageSpeechSourceFailureReason,
  MessageSpeechError,
  messageSpeechRecipeHash,
} from "../voice/MessageSpeech.ts";
import { messageArtifactTextHash } from "./identity.ts";
import { makeMessageArtifactLockCoordinator } from "./lock.ts";
import { currentArtifactSourceCondition, findMessageArtifactSource } from "./source.ts";

export interface MessageSpeechScriptRequest {
  readonly messageId: MessageId;
  /** The speech profile's character limit; bounds both the source and the script. */
  readonly maxScriptChars: number;
  /** Text-generation model that rewrites the message for the ear. */
  readonly modelSelection: ModelSelection;
  /** The speech profile's style instructions; part of the script recipe. */
  readonly instructions?: string | undefined;
}

export interface MessageSpeechScriptResult {
  readonly messageId: string;
  readonly threadId: string;
  readonly script: string;
  /** Hash of the trimmed message text the script was written from. */
  readonly sourceTextHash: string;
  readonly scriptRecipeHash: string;
  readonly createdAt: string;
}

/**
 * The spoken form of an assistant message, generated once per message text and
 * recipe and stored in `fork_message_speech_scripts`. Listening synthesizes
 * audio from it; a changed message or recipe regenerates it.
 */
export class MessageSpeechScript extends Context.Service<
  MessageSpeechScript,
  {
    readonly generate: (
      request: MessageSpeechScriptRequest,
    ) => Effect.Effect<MessageSpeechScriptResult, MessageSpeechError>;
  }
>()("t3/messageArtifacts/MessageSpeechScript") {}

const storageError = () => new MessageSpeechError({ reason: "storage_failed" });
const scriptFailed = () => new MessageSpeechError({ reason: "script_failed" });

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const textGeneration = yield* TextGeneration;
  // One generation per message at a time: a concurrent request waits, then
  // reuses the stored script instead of starting a second provider job.
  const locks = yield* makeMessageArtifactLockCoordinator();

  const generateUnlocked = Effect.fn("MessageSpeechScript.generateUnlocked")(function* (
    request: MessageSpeechScriptRequest,
  ) {
    const message = yield* findMessageArtifactSource(sql, request.messageId).pipe(
      Effect.mapError(storageError),
    );
    if (message === undefined) {
      return yield* new MessageSpeechError({ reason: "message_unavailable" });
    }
    const sourceFailure = getMessageSpeechSourceFailureReason({
      role: message.role,
      isStreaming: message.streaming !== 0,
      text: message.text,
      maxSourceChars: request.maxScriptChars,
    });
    if (sourceFailure !== null) {
      return yield* new MessageSpeechError({ reason: sourceFailure });
    }
    const sourceText = message.text.trim();
    const sourceTextHash = messageArtifactTextHash(sourceText);
    const scriptRecipeHash = messageSpeechRecipeHash({
      modelSelection: request.modelSelection,
      instructions: request.instructions,
    });

    const cached = (yield* sql<MessageSpeechScriptResult>`
      SELECT
        message_id AS "messageId",
        thread_id AS "threadId",
        script,
        source_text_hash AS "sourceTextHash",
        script_recipe_hash AS "scriptRecipeHash",
        created_at AS "createdAt"
      FROM fork_message_speech_scripts
      WHERE message_id = ${message.messageId}
    `.pipe(Effect.mapError(storageError)))[0];
    if (
      cached?.sourceTextHash === sourceTextHash &&
      cached.scriptRecipeHash === scriptRecipeHash &&
      cached.script.length <= request.maxScriptChars
    ) {
      return cached;
    }

    // The rewrite never needs the workspace, so the provider gets an empty
    // directory instead of the project.
    const generated = yield* Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-message-speech-",
        });
        return yield* textGeneration.generateSpeechScript({
          cwd,
          message: sourceText,
          maxScriptChars: request.maxScriptChars,
          modelSelection: request.modelSelection,
        });
      }),
    ).pipe(Effect.mapError(scriptFailed));
    const script = generated.script.trim();
    if (script.length === 0 || script.length > request.maxScriptChars) {
      return yield* scriptFailed();
    }
    const createdAt = DateTime.formatIso(yield* DateTime.now);

    // Stored only while the message still has the text the script came from;
    // otherwise the script is stale and the request fails like a vanished message.
    const stored = yield* sql`
      INSERT INTO fork_message_speech_scripts (
        message_id,
        thread_id,
        script,
        source_text_hash,
        script_recipe_hash,
        created_at
      )
      SELECT
        ${message.messageId},
        ${message.threadId},
        ${script},
        ${sourceTextHash},
        ${scriptRecipeHash},
        ${createdAt}
      WHERE ${currentArtifactSourceCondition(sql, message)}
      ON CONFLICT(message_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        script = excluded.script,
        source_text_hash = excluded.source_text_hash,
        script_recipe_hash = excluded.script_recipe_hash,
        created_at = excluded.created_at
      RETURNING message_id
    `.pipe(Effect.mapError(storageError));
    if (stored.length === 0) {
      return yield* new MessageSpeechError({ reason: "message_unavailable" });
    }

    return {
      messageId: message.messageId,
      threadId: message.threadId,
      script,
      sourceTextHash,
      scriptRecipeHash,
      createdAt,
    } satisfies MessageSpeechScriptResult;
  });

  return MessageSpeechScript.of({
    generate: (request) => locks.withMessageLock(request.messageId, generateUnlocked(request)),
  });
});

export const layer = Layer.effect(MessageSpeechScript, make);
