import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const SESSION_IMPORT_WS_METHODS = {
  listCandidates: "sessionImport.listCandidates",
  importSession: "sessionImport.import",
} as const;

export class SessionImportError extends Schema.TaggedErrorClass<SessionImportError>()(
  "SessionImportError",
  {
    reason: Schema.Literals([
      "project-not-found",
      "instance-not-found",
      "provider-read-failed",
      "nothing-to-import",
      "already-imported",
      "fork-unsupported",
      "invalid-model",
      "invalid-options",
      "invalid-worktree",
      "import-failed",
    ]),
    detail: Schema.String,
    existingThreadId: Schema.optional(ThreadId),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/** The t3 thread that already owns a native session's continuation. */
export const SessionImportLinkedThread = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  archivedAt: Schema.NullOr(IsoDateTime),
  /** Last activity t3 recorded for the thread, for comparison with the session. */
  updatedAt: IsoDateTime,
  /** Whether the listing provider instance can fork this session for re-import. */
  canFork: Schema.Boolean,
});
export type SessionImportLinkedThread = typeof SessionImportLinkedThread.Type;

export const SessionImportCandidate = Schema.Struct({
  instanceId: ProviderInstanceId,
  provider: ProviderDriverKind,
  providerDisplayName: TrimmedNonEmptyString,
  nativeSessionId: TrimmedNonEmptyString,
  /** Provider-derived session title, preferring an explicit user-assigned name. */
  name: Schema.NullOr(Schema.String),
  preview: Schema.String,
  messageCount: Schema.NullOr(Schema.Number),
  updatedAt: IsoDateTime,
  /**
   * Set when a t3 thread already owns this session's continuation. Such a
   * candidate is listed rather than hidden, but importing it again requires
   * `fork` so the two threads never resume the same provider session. Absent
   * means the server predates linked candidates; those servers hide bound
   * sessions entirely, so clients must treat absence as null.
   */
  linkedThread: Schema.optional(Schema.NullOr(SessionImportLinkedThread)),
});
export type SessionImportCandidate = typeof SessionImportCandidate.Type;

export const SessionImportListCandidatesPayload = Schema.Struct({
  projectId: ProjectId,
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type SessionImportListCandidatesPayload = typeof SessionImportListCandidatesPayload.Type;

export const SessionImportListCandidatesResult = Schema.Struct({
  candidates: Schema.Array(SessionImportCandidate),
});
export type SessionImportListCandidatesResult = typeof SessionImportListCandidatesResult.Type;

export const SessionImportPayload = Schema.Struct({
  projectId: ProjectId,
  instanceId: ProviderInstanceId,
  nativeSessionId: TrimmedNonEmptyString,
  /** Overrides the title derived from the provider session (e.g. to carry a T3 thread title across a handover). */
  title: Schema.optional(TrimmedNonEmptyString),
  /**
   * Permit importing a session another thread already continues by forking it
   * into a fresh provider session. Ignored when the session is unlinked.
   */
  fork: Schema.optional(Schema.Boolean),
  modelSelection: Schema.optional(ModelSelection),
  worktree: Schema.optional(
    Schema.Struct({
      branch: TrimmedNonEmptyString,
      worktreePath: TrimmedNonEmptyString,
    }),
  ),
});
export type SessionImportPayload = typeof SessionImportPayload.Type;

export const SessionImportWarning = Schema.Struct({
  code: Schema.Literals(["meta-update-failed", "history-truncated"]),
  message: Schema.String,
});
export type SessionImportWarning = typeof SessionImportWarning.Type;

export const SessionImportResult = Schema.Struct({
  threadId: ThreadId,
  warnings: Schema.optional(Schema.Array(SessionImportWarning)),
});
export type SessionImportResult = typeof SessionImportResult.Type;
