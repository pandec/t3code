import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Regex sources for the pieces of a Linear identifier, shared by the settings normalizer, the
 * URL parser, and the prose autolinker so the three never drift. Team keys are one letter and up
 * to nine more upper-case alphanumerics; issue numbers never carry a leading zero and stay under
 * eight digits. Wrap or anchor as needed and pick the flags at the call site.
 */
export const LINEAR_TEAM_KEY_SOURCE = "[A-Z][A-Z0-9]{0,9}";
export const LINEAR_ISSUE_NUMBER_SOURCE = "[1-9]\\d{0,6}";

export const LinearUser = Schema.Struct({
  name: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
});
export type LinearUser = typeof LinearUser.Type;

export const LinearWorkspace = Schema.Struct({
  name: TrimmedNonEmptyString,
  urlKey: TrimmedNonEmptyString,
});
export type LinearWorkspace = typeof LinearWorkspace.Type;

export const LinearStatus = Schema.Struct({
  configured: Schema.Boolean,
  viewer: Schema.NullOr(
    Schema.Struct({
      name: TrimmedNonEmptyString,
      displayName: TrimmedNonEmptyString,
    }),
  ),
  workspace: Schema.NullOr(LinearWorkspace),
  teamKeys: Schema.Array(TrimmedNonEmptyString),
  error: Schema.optional(Schema.String),
});
export type LinearStatus = typeof LinearStatus.Type;

export const LinearStatusInput = Schema.Struct({});
export type LinearStatusInput = typeof LinearStatusInput.Type;

export const LinearConfigureInput = Schema.Struct({ apiKey: Schema.String });
export type LinearConfigureInput = typeof LinearConfigureInput.Type;

export const LinearIssueState = Schema.Struct({
  name: TrimmedNonEmptyString,
  type: TrimmedNonEmptyString,
  color: TrimmedNonEmptyString,
});
export type LinearIssueState = typeof LinearIssueState.Type;

export const LinearIssue = Schema.Struct({
  id: TrimmedNonEmptyString,
  identifier: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  description: Schema.NullOr(Schema.String),
  priorityLabel: TrimmedNonEmptyString,
  state: LinearIssueState,
  team: Schema.Struct({ name: TrimmedNonEmptyString }),
  project: Schema.NullOr(Schema.Struct({ name: TrimmedNonEmptyString })),
  assignee: Schema.NullOr(LinearUser),
  creator: Schema.NullOr(LinearUser),
  labels: Schema.Array(
    Schema.Struct({ name: TrimmedNonEmptyString, color: TrimmedNonEmptyString }),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  dueDate: Schema.NullOr(Schema.String),
});
export type LinearIssue = typeof LinearIssue.Type;

export const LinearIssueInput = Schema.Struct({
  identifier: TrimmedNonEmptyString,
  refresh: Schema.optional(Schema.Boolean),
});
export type LinearIssueInput = typeof LinearIssueInput.Type;

export const LinearComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  body: Schema.String,
  createdAt: IsoDateTime,
  user: Schema.NullOr(LinearUser),
  botActor: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        name: TrimmedNonEmptyString,
        avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});
export type LinearComment = typeof LinearComment.Type;

export const LinearCommentsInput = Schema.Struct({
  identifier: TrimmedNonEmptyString,
  refresh: Schema.optional(Schema.Boolean),
});
export type LinearCommentsInput = typeof LinearCommentsInput.Type;

export const LinearCommentsResult = Schema.Struct({
  comments: Schema.Array(LinearComment),
  truncated: Schema.Boolean,
});
export type LinearCommentsResult = typeof LinearCommentsResult.Type;

export const LinearCreateCommentInput = Schema.Struct({
  issueId: TrimmedNonEmptyString,
  body: TrimmedNonEmptyString,
});
export type LinearCreateCommentInput = typeof LinearCreateCommentInput.Type;

export const LinearRpcErrorReason = Schema.Literals([
  "unconfigured",
  "unauthenticated",
  "not-found",
  "rate-limited",
  "failed",
]);
export type LinearRpcErrorReason = typeof LinearRpcErrorReason.Type;

export class LinearRpcError extends Schema.TaggedErrorClass<LinearRpcError>()("LinearRpcError", {
  reason: LinearRpcErrorReason,
  detail: TrimmedNonEmptyString,
}) {
  override get message(): string {
    return this.detail;
  }
}
