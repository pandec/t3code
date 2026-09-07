import type {
  EnvironmentId,
  LinearComment,
  LinearIssue,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { ExternalLinkIcon, SendIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { RefreshIcon } from "~/components/ui/refresh-icon";
import { readLocalApi } from "~/localApi";
import { linearEnvironment, useLinearFailureReason } from "~/state/linear";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import ChatMarkdown from "../ChatMarkdown";
import { LinearIcon } from "../Icons";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { LinearStateBadge, LinearUserAvatar, linearUserLabel } from "./linearPresentation";

function openExternal(url: string) {
  void readLocalApi()?.shell.openExternal(url);
}

function LinearUnavailable({ title, description }: { title: string; description: string }) {
  return (
    <Empty className="px-4 py-16 md:px-4">
      <EmptyMedia variant="icon">
        <LinearIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-foreground/90">{children}</dd>
    </>
  );
}

function IssueMeta({ issue }: { issue: LinearIssue }) {
  return (
    <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
      <MetaRow label="State">
        <LinearStateBadge state={issue.state} />
      </MetaRow>
      <MetaRow label="Priority">{issue.priorityLabel}</MetaRow>
      <MetaRow label="Assignee">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <LinearUserAvatar user={issue.assignee} />
          <span className="truncate">{linearUserLabel(issue.assignee, "Unassigned")}</span>
        </span>
      </MetaRow>
      <MetaRow label="Team">{issue.team.name}</MetaRow>
      {issue.project ? <MetaRow label="Project">{issue.project.name}</MetaRow> : null}
      {issue.labels.length > 0 ? (
        <MetaRow label="Labels">
          <span className="flex flex-wrap gap-1">
            {issue.labels.map((label) => (
              <span
                key={label.name}
                className="inline-flex items-center gap-1 rounded-sm border border-border/60 px-1 text-[11px]"
              >
                <span
                  aria-hidden
                  className="size-1.5 rounded-full"
                  style={{ backgroundColor: label.color }}
                />
                {label.name}
              </span>
            ))}
          </span>
        </MetaRow>
      ) : null}
      {issue.dueDate ? <MetaRow label="Due">{issue.dueDate}</MetaRow> : null}
      <MetaRow label="Created">
        {formatRelativeTimeLabel(issue.createdAt)}
        {issue.creator ? ` by ${linearUserLabel(issue.creator, "")}` : ""}
      </MetaRow>
      <MetaRow label="Updated">{formatRelativeTimeLabel(issue.updatedAt)}</MetaRow>
    </dl>
  );
}

function CommentItem({
  comment,
  environmentId,
  threadRef,
}: {
  comment: LinearComment;
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef | null;
}) {
  const author =
    comment.user !== null
      ? linearUserLabel(comment.user, "Unknown")
      : (comment.botActor?.name ?? "Linear");
  return (
    <li className="rounded-md border border-border/60 p-3">
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <LinearUserAvatar
          user={
            comment.user ??
            (comment.botActor
              ? {
                  name: comment.botActor.name,
                  displayName: comment.botActor.name,
                  avatarUrl: comment.botActor.avatarUrl ?? null,
                }
              : null)
          }
        />
        <span className="min-w-0 truncate font-medium text-foreground/90">{author}</span>
        <span aria-hidden>·</span>
        <span className="shrink-0">{formatRelativeTimeLabel(comment.createdAt)}</span>
      </div>
      <ChatMarkdown
        className="mt-2"
        text={comment.body}
        cwd={undefined}
        environmentId={environmentId}
        threadRef={threadRef ?? undefined}
      />
    </li>
  );
}

function CommentComposer({
  environmentId,
  issueId,
  onPosted,
}: {
  environmentId: EnvironmentId;
  issueId: string;
  onPosted: () => void;
}) {
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);
  const createComment = useAtomCommand(linearEnvironment.createComment, { reportFailure: false });
  const submit = async () => {
    const trimmed = body.trim();
    if (trimmed.length === 0 || posting) return;
    setPosting(true);
    const result = await createComment({ environmentId, input: { issueId, body: trimmed } });
    setPosting(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not post the comment" });
      return;
    }
    setBody("");
    onPosted();
  };
  return (
    <div className="mt-3 space-y-2">
      <Textarea
        disabled={posting}
        value={body}
        rows={3}
        placeholder="Leave a comment"
        aria-label="Comment on this issue"
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="flex justify-end">
        <Button
          size="xs"
          variant="outline"
          disabled={body.trim().length === 0 || posting}
          onClick={() => void submit()}
        >
          <SendIcon className="size-3.5" />
          {posting ? "Posting..." : "Comment"}
        </Button>
      </div>
    </div>
  );
}

export function LinearIssueDetailPanel({
  environmentId,
  threadRef,
  identifier,
  supported,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef | null;
  identifier: string;
  /** Whether the environment's server exposes the Linear RPCs at all. */
  supported: boolean;
}) {
  const target = { environmentId, input: { identifier } };
  const issueAtom = supported ? linearEnvironment.issue(target) : null;
  const issueQuery = useEnvironmentQuery(issueAtom);
  const issueFailure = useLinearFailureReason(issueAtom);
  const commentsQuery = useEnvironmentQuery(supported ? linearEnvironment.comments(target) : null);
  const readIssue = useAtomQueryRunner(linearEnvironment.issue, { reportFailure: false });
  const readComments = useAtomQueryRunner(linearEnvironment.comments, { reportFailure: false });
  const [refreshing, setRefreshing] = useState(false);
  const refreshIssue = issueQuery.refresh;
  const refreshComments = commentsQuery.refresh;
  // The server caches each read for a minute; `refresh: true` busts it, and the displayed atoms
  // then re-read the fresh entry.
  const refresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([
      readIssue({ environmentId, input: { identifier, refresh: true } }),
      readComments({ environmentId, input: { identifier, refresh: true } }),
    ]);
    refreshIssue();
    refreshComments();
    setRefreshing(false);
  }, [environmentId, identifier, readComments, readIssue, refreshComments, refreshIssue]);

  if (!supported) {
    return (
      <LinearUnavailable
        title="Linear issues unavailable"
        description="Update this environment's T3 Code server to open Linear issues here."
      />
    );
  }
  const issue = issueQuery.data;
  if (issue === null && issueQuery.error !== null) {
    const unconfigured = issueFailure === "unconfigured";
    return (
      <LinearUnavailable
        title={unconfigured ? "Linear is not connected" : `Could not load ${identifier}`}
        description={
          unconfigured
            ? "Add a Linear API key for this environment under Settings → Extras → Linear."
            : issueQuery.error
        }
      />
    );
  }
  const busy = refreshing || issueQuery.isPending;

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border/60 px-4 text-xs">
        <LinearIcon className="size-3 shrink-0 text-muted-foreground" />
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={() => issue && openExternal(issue.url)}
                disabled={issue === null}
                className="inline-flex min-w-0 shrink-0 cursor-pointer items-center gap-0.5 font-medium underline-offset-2 hover:underline disabled:cursor-default disabled:no-underline"
                aria-label={`Open ${identifier} in Linear`}
              >
                {identifier}
                <ExternalLinkIcon aria-hidden className="size-2.5" />
              </button>
            }
          />
          <TooltipPopup side="top">Open in Linear</TooltipPopup>
        </Tooltip>
        {issue ? (
          <span className="min-w-0 truncate font-medium text-foreground">{issue.title}</span>
        ) : null}
        <Button
          aria-label="Refresh issue"
          className="ml-auto size-6"
          size="icon-xs"
          variant="ghost-muted"
          disabled={busy}
          onClick={() => void refresh()}
        >
          <RefreshIcon className="size-3.5" refreshing={busy} />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {issue === null ? (
          <p className="text-xs text-muted-foreground">Loading issue…</p>
        ) : (
          <>
            <h1 className="text-base font-semibold leading-snug text-pretty">{issue.title}</h1>
            <IssueMeta issue={issue} />
            {issue.description && issue.description.trim().length > 0 ? (
              <ChatMarkdown
                className="mt-4"
                text={issue.description}
                cwd={undefined}
                environmentId={environmentId}
                threadRef={threadRef ?? undefined}
              />
            ) : (
              <p className="mt-4 text-xs text-muted-foreground">No description.</p>
            )}
            <h2 className="mt-6 text-xs font-medium text-muted-foreground">
              Comments
              {commentsQuery.data
                ? ` (${commentsQuery.data.comments.length}${commentsQuery.data.truncated ? "+" : ""})`
                : ""}
            </h2>
            {commentsQuery.data === null ? (
              <p className="mt-2 text-xs text-muted-foreground">
                {commentsQuery.error ?? "Loading comments…"}
              </p>
            ) : commentsQuery.data.comments.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">No comments yet.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {commentsQuery.data.comments.map((comment) => (
                  <CommentItem
                    key={comment.id}
                    comment={comment}
                    environmentId={environmentId}
                    threadRef={threadRef}
                  />
                ))}
              </ul>
            )}
            {commentsQuery.data?.truncated ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Only the first {commentsQuery.data.comments.length} comments are shown.
              </p>
            ) : null}
            <CommentComposer
              environmentId={environmentId}
              issueId={issue.id}
              onPosted={refreshComments}
            />
          </>
        )}
      </div>
    </div>
  );
}
