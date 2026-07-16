import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
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
      "import-failed",
    ]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const SessionImportCandidate = Schema.Struct({
  instanceId: ProviderInstanceId,
  provider: ProviderDriverKind,
  providerDisplayName: TrimmedNonEmptyString,
  nativeSessionId: TrimmedNonEmptyString,
  preview: Schema.String,
  messageCount: Schema.NullOr(Schema.Number),
  updatedAt: IsoDateTime,
});
export type SessionImportCandidate = typeof SessionImportCandidate.Type;

export const SessionImportListCandidatesPayload = Schema.Struct({
  projectId: ProjectId,
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
});
export type SessionImportPayload = typeof SessionImportPayload.Type;

export const SessionImportResult = Schema.Struct({
  threadId: ThreadId,
});
export type SessionImportResult = typeof SessionImportResult.Type;
