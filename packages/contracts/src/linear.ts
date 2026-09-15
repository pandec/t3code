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
  /** The member's Linear profile page. Absent from servers older than the field. */
  url: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
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

/** Another issue named from this one: its parent, a sub-issue, or a relation. */
export const LinearIssueRef = Schema.Struct({
  identifier: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  state: LinearIssueState,
});
export type LinearIssueRef = typeof LinearIssueRef.Type;

/**
 * A relation as seen from the issue being read. Linear stores one edge per pair and names it
 * from the side that created it; the server folds the inverse edges into these kinds so the
 * panel never has to know which side it is on.
 */
export const LinearIssueRelationKind = Schema.Literals([
  "blocks",
  "blocked-by",
  "duplicate-of",
  "duplicated-by",
  "related",
]);
export type LinearIssueRelationKind = typeof LinearIssueRelationKind.Type;

export const LinearIssueRelation = Schema.Struct({
  kind: LinearIssueRelationKind,
  issue: LinearIssueRef,
});
export type LinearIssueRelation = typeof LinearIssueRelation.Type;

export const LinearAttachment = Schema.Struct({
  title: Schema.String,
  subtitle: Schema.NullOr(Schema.String),
  url: TrimmedNonEmptyString,
  /** Linear's integration name for the link, such as `github` or `figma`, or null for a plain URL. */
  sourceType: Schema.NullOr(Schema.String),
});
export type LinearAttachment = typeof LinearAttachment.Type;

export const LinearProjectStatus = Schema.Struct({
  name: TrimmedNonEmptyString,
  type: TrimmedNonEmptyString,
  color: TrimmedNonEmptyString,
});
export type LinearProjectStatus = typeof LinearProjectStatus.Type;

// Everything after `dueDate` is optional so an issue read from a server that predates the field
// still decodes; the panel treats a missing field like an empty one.
export const LinearIssue = Schema.Struct({
  id: TrimmedNonEmptyString,
  identifier: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  description: Schema.NullOr(Schema.String),
  priorityLabel: TrimmedNonEmptyString,
  state: LinearIssueState,
  team: Schema.Struct({
    name: TrimmedNonEmptyString,
    key: Schema.optional(TrimmedNonEmptyString),
    color: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  project: Schema.NullOr(
    Schema.Struct({
      name: TrimmedNonEmptyString,
      url: Schema.optional(TrimmedNonEmptyString),
      color: Schema.optional(Schema.NullOr(Schema.String)),
      status: Schema.optional(Schema.NullOr(LinearProjectStatus)),
    }),
  ),
  assignee: Schema.NullOr(LinearUser),
  creator: Schema.NullOr(LinearUser),
  labels: Schema.Array(
    Schema.Struct({ name: TrimmedNonEmptyString, color: TrimmedNonEmptyString }),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  dueDate: Schema.NullOr(Schema.String),
  /** 0 = none, 1 = urgent, 2 = high, 3 = medium, 4 = low, as Linear numbers them. */
  priority: Schema.optional(Schema.Number),
  estimate: Schema.optional(Schema.NullOr(Schema.Number)),
  cycle: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ number: Schema.Number, name: Schema.NullOr(TrimmedNonEmptyString) }),
    ),
  ),
  milestone: Schema.optional(Schema.NullOr(Schema.Struct({ name: TrimmedNonEmptyString }))),
  /** The workspace's Linear URL key, so team and cycle pages can be linked without a URL field. */
  workspaceUrlKey: Schema.optional(TrimmedNonEmptyString),
  branchName: Schema.optional(TrimmedNonEmptyString),
  startedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  completedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  canceledAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  parent: Schema.optional(Schema.NullOr(LinearIssueRef)),
  children: Schema.optional(Schema.Array(LinearIssueRef)),
  relations: Schema.optional(Schema.Array(LinearIssueRelation)),
  attachments: Schema.optional(Schema.Array(LinearAttachment)),
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

export class LinearRpcError extends Schema.TaggedError<LinearRpcError>()("LinearRpcError", {
  reason: LinearRpcErrorReason,
  detail: TrimmedNonEmptyString,
}) {
  override get message(): string {
    return this.detail;
  }
}
