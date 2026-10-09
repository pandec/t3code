/**
 * Fork: per-instance access to sessions a provider CLI persisted outside
 * T3 Code, for explicit session import and handover. Drivers build it over
 * the instance's own home and environment; `cwd` is always a canonical
 * (realpath) directory.
 *
 * @module sessionImport
 */
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ProviderSessionImportError extends Schema.TaggedError<ProviderSessionImportError>()(
  "ProviderSessionImportError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface ProviderImportableSession {
  readonly nativeSessionId: string;
  /** Provider-derived session title, preferring an explicit user-assigned name. */
  readonly name: string | null;
  readonly preview: string;
  readonly messageCount: number | null;
  readonly updatedAt: string;
}

export interface ProviderImportedMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export interface ProviderImportedSession {
  readonly nativeSessionId: string;
  readonly name: string | null;
  readonly messages: ReadonlyArray<ProviderImportedMessage>;
  /** Last model the session used, when the transcript records one. */
  readonly model: string | null;
}

export interface ProviderSessionImport {
  readonly listSessions: (input: {
    readonly cwd: string;
  }) => Effect.Effect<ReadonlyArray<ProviderImportableSession>, ProviderSessionImportError>;
  readonly readSession: (input: {
    readonly nativeSessionId: string;
    readonly cwd: string;
  }) => Effect.Effect<ProviderImportedSession, ProviderSessionImportError>;
  /** Copies a session into a new native session and returns its id. */
  readonly forkSession?: (input: {
    readonly nativeSessionId: string;
    readonly cwd: string;
  }) => Effect.Effect<string, ProviderSessionImportError>;
}
