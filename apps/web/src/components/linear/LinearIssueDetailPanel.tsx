import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import type {
  EnvironmentId,
  LinearAttachment,
  LinearComment,
  LinearIssue,
  LinearIssueRef,
  LinearIssueRelationKind,
  LinearUser,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  CopyIcon,
  CornerLeftUpIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  LinkIcon,
  SendIcon,
} from "lucide-react";
import { useCallback, useRef, useState, type ReactNode } from "react";

import { RefreshIcon } from "~/components/ui/refresh-icon";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { linearEnvironment, useLinearFailureReason } from "~/state/linear";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { useRightPanelStore } from "../../rightPanelStore";
import ChatMarkdown from "../ChatMarkdown";
import { LinearIcon } from "../Icons";
import { showAnchoredCopyErrorToast, showAnchoredCopySuccessToast } from "../ui/anchoredCopyToast";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { linearCommentDraftKey, useLinearCommentDraftStore } from "./linearCommentDraftStore";
import { linearIssueUrl } from "./linearMarkdown.logic";
import {
  formatLinearDueDate,
  LinearLabelPill,
  LinearPriorityIcon,
  LinearStateIcon,
  LinearUserAvatar,
  linearUserLabel,
} from "./linearPresentation";

/**
 * Attachment URLs are typed by whoever attached them, so only web URLs are handed to the
 * shell; every other link the panel opens is one Linear generated.
 */
function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function openExternal(url: string) {
  if (!isWebUrl(url)) return;
  void readLocalApi()?.shell.openExternal(url);
}

/** Team pages have no URL field in Linear's API; this is the shape the app uses for them. */
function linearTeamUrl(workspaceUrlKey: string, teamKey: string): string {
  return `https://linear.app/${workspaceUrlKey}/team/${teamKey}/overview`;
}

const RELATION_GROUPS: ReadonlyArray<{ kind: LinearIssueRelationKind; label: string }> = [
  { kind: "blocked-by", label: "Blocked by" },
  { kind: "blocks", label: "Blocks" },
  { kind: "duplicate-of", label: "Duplicate of" },
  { kind: "duplicated-by", label: "Duplicated by" },
  { kind: "related", label: "Related" },
];

const isEnded = (state: LinearIssueRef["state"]) =>
  state.type === "completed" || state.type === "canceled";

/**
 * The panel's stand-in when it has no issue to show. The link that opened it was taken over
 * from the browser, so the way out to Linear has to be offered here.
 */
function LinearUnavailable({
  title,
  description,
  identifier,
}: {
  title: string;
  description: string;
  identifier: string;
}) {
  return (
    <Empty>
      <EmptyMedia variant="icon">
        <LinearIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      <Button size="xs" variant="outline" onClick={() => openExternal(linearIssueUrl(identifier))}>
        <ExternalLinkIcon className="size-3.5" />
        Open in Linear
      </Button>
    </Empty>
  );
}

/**
 * One property of the issue. A chip with a destination renders as a button that opens it in the
 * browser; the rest are plain badges in the same clothes so the row reads as one thing.
 */
function Chip({
  href,
  onClick,
  label,
  className,
  children,
}: {
  href?: string | null | undefined;
  onClick?: (() => void) | undefined;
  /** Accessible name for interactive chips whose visible text alone is ambiguous. */
  label?: string | undefined;
  className?: string | undefined;
  children: ReactNode;
}) {
  const open = onClick ?? (href ? () => openExternal(href) : undefined);
  return (
    <Badge
      size="control"
      variant="outline"
      className={cn("max-w-full min-w-0 justify-start", className)}
      {...(open ? { render: <button type="button" aria-label={label} onClick={open} /> } : {})}
    >
      {children}
    </Badge>
  );
}

function ChipText({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return (
    <span className={cn("min-w-0 truncate", muted && "text-muted-foreground")}>{children}</span>
  );
}

function PropertyChips({ issue }: { issue: LinearIssue }) {
  const teamHref =
    issue.workspaceUrlKey && issue.team.key
      ? linearTeamUrl(issue.workspaceUrlKey, issue.team.key)
      : null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      <Chip>
        <LinearStateIcon state={issue.state} />
        <ChipText>{issue.state.name}</ChipText>
      </Chip>
      <Chip>
        {issue.priority !== undefined ? (
          <LinearPriorityIcon priority={issue.priority} className="text-foreground/80" />
        ) : null}
        <ChipText muted={issue.priority === 0}>{issue.priorityLabel}</ChipText>
      </Chip>
      <Chip
        href={issue.assignee?.url}
        label={issue.assignee ? `Open ${linearUserLabel(issue.assignee, "")} in Linear` : undefined}
      >
        <LinearUserAvatar user={issue.assignee} className="size-3.5" />
        <ChipText muted={issue.assignee === null}>
          {linearUserLabel(issue.assignee, "Unassigned")}
        </ChipText>
      </Chip>
      {issue.project ? (
        <Chip href={issue.project.url} label={`Open project ${issue.project.name} in Linear`}>
          <span
            aria-hidden
            className="size-2.5 shrink-0 rounded-xs"
            style={{ backgroundColor: issue.project.color ?? "currentColor" }}
          />
          <ChipText>{issue.project.name}</ChipText>
          {issue.project.status ? (
            <span className="shrink-0 text-muted-foreground">· {issue.project.status.name}</span>
          ) : null}
        </Chip>
      ) : null}
      <Chip href={teamHref} label={`Open team ${issue.team.name} in Linear`}>
        {issue.team.key ? (
          <span className="shrink-0 rounded-xs bg-muted px-1 font-mono text-3xs leading-4 text-muted-foreground">
            {issue.team.key}
          </span>
        ) : null}
        <ChipText>{issue.team.name}</ChipText>
      </Chip>
      {issue.cycle ? (
        <Chip>
          <span className="shrink-0 text-muted-foreground">Cycle</span>
          <ChipText>{issue.cycle.name ?? issue.cycle.number}</ChipText>
        </Chip>
      ) : null}
      {issue.milestone ? (
        <Chip>
          <span className="shrink-0 text-muted-foreground">Milestone</span>
          <ChipText>{issue.milestone.name}</ChipText>
        </Chip>
      ) : null}
      {issue.estimate !== null && issue.estimate !== undefined ? (
        <Chip>
          <span className="shrink-0 text-muted-foreground">Estimate</span>
          <ChipText>{issue.estimate}</ChipText>
        </Chip>
      ) : null}
    </div>
  );
}

function UserLink({ user }: { user: LinearUser }) {
  const name = linearUserLabel(user, "");
  const body = (
    <>
      <LinearUserAvatar user={user} className="size-3.5" />
      <span className="min-w-0 truncate">{name}</span>
    </>
  );
  return user.url ? (
    <button
      type="button"
      onClick={() => openExternal(user.url!)}
      className="inline-flex min-w-0 cursor-pointer items-center gap-1 underline-offset-2 hover:underline"
    >
      {body}
    </button>
  ) : (
    <span className="inline-flex min-w-0 items-center gap-1">{body}</span>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1 truncate text-foreground/90">{children}</dd>
    </>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const copy = () => {
    if (!navigator.clipboard?.writeText) {
      showAnchoredCopyErrorToast(ref, new Error("Clipboard API unavailable."));
      return;
    }
    void navigator.clipboard.writeText(value).then(
      () => showAnchoredCopySuccessToast(ref),
      (error: unknown) =>
        showAnchoredCopyErrorToast(
          ref,
          error instanceof Error ? error : new Error("An error occurred."),
        ),
    );
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            ref={ref}
            aria-label={label}
            size="icon-micro"
            variant="ghost-muted"
            onClick={copy}
          >
            <CopyIcon className="size-3" />
          </Button>
        }
      />
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Timestamps, the due date, and the branch name. Two label/value pairs per row once the panel
 * is wide enough for them, one below the other before that.
 */
function IssueDetails({ issue }: { issue: LinearIssue }) {
  const due = issue.dueDate ? formatLinearDueDate(issue.dueDate) : null;
  const settled = isEnded(issue.state);
  return (
    <div className="mt-5 border-t border-border/60 pt-4 text-xs">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 @[26rem]/linear-issue:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)] @[26rem]/linear-issue:gap-x-4">
        <DetailRow label="Created">
          <span className="shrink-0">{formatRelativeTimeLabel(issue.createdAt)}</span>
          {issue.creator ? (
            <>
              <span className="shrink-0 text-muted-foreground">by</span>
              <UserLink user={issue.creator} />
            </>
          ) : null}
        </DetailRow>
        <DetailRow label="Updated">{formatRelativeTimeLabel(issue.updatedAt)}</DetailRow>
        {issue.startedAt ? (
          <DetailRow label="Started">{formatRelativeTimeLabel(issue.startedAt)}</DetailRow>
        ) : null}
        {issue.completedAt ? (
          <DetailRow label="Completed">{formatRelativeTimeLabel(issue.completedAt)}</DetailRow>
        ) : null}
        {issue.canceledAt ? (
          <DetailRow label="Canceled">{formatRelativeTimeLabel(issue.canceledAt)}</DetailRow>
        ) : null}
        {due ? (
          <DetailRow label="Due">
            <span className={cn(due.overdue && !settled && "text-destructive-foreground")}>
              {due.label}
              {due.overdue && !settled ? " · overdue" : ""}
            </span>
          </DetailRow>
        ) : issue.dueDate ? (
          <DetailRow label="Due">{issue.dueDate}</DetailRow>
        ) : null}
      </dl>
      {issue.branchName ? (
        <div className="mt-2.5 flex min-w-0 items-center gap-1.5">
          <GitBranchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <code className="min-w-0 truncate font-mono text-2xs text-foreground/90">
            {issue.branchName}
          </code>
          <CopyButton value={issue.branchName} label="Copy branch name" />
        </div>
      ) : null}
    </div>
  );
}

function Section({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-5">
      <h2 className="text-xs font-medium text-muted-foreground">
        {title}
        {detail ? <span className="font-normal"> · {detail}</span> : null}
      </h2>
      {children}
    </section>
  );
}

function IssueRefRow({
  issue,
  onOpen,
}: {
  issue: LinearIssueRef;
  onOpen: (issue: LinearIssueRef) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(issue)}
        className="-mx-1.5 flex w-[calc(100%+--spacing(3))] min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-accent/50"
      >
        <LinearStateIcon state={issue.state} />
        <span className="shrink-0 text-muted-foreground">{issue.identifier}</span>
        <span
          className={cn(
            "min-w-0 truncate",
            isEnded(issue.state) ? "text-muted-foreground" : "text-foreground/90",
          )}
        >
          {issue.title}
        </span>
      </button>
    </li>
  );
}

function IssueRefList({
  issues,
  onOpen,
}: {
  issues: ReadonlyArray<LinearIssueRef>;
  onOpen: (issue: LinearIssueRef) => void;
}) {
  return (
    <ul className="mt-1">
      {issues.map((issue) => (
        <IssueRefRow key={issue.identifier} issue={issue} onOpen={onOpen} />
      ))}
    </ul>
  );
}

function AttachmentRow({ attachment }: { attachment: LinearAttachment }) {
  const Icon = /github|gitlab|bitbucket/i.test(attachment.sourceType ?? "")
    ? PullRequestGlyph.pullRequest
    : LinkIcon;
  const title = attachment.title.trim().length > 0 ? attachment.title : attachment.url;
  return (
    <li>
      <button
        type="button"
        onClick={() => openExternal(attachment.url)}
        className="-mx-1.5 flex w-[calc(100%+--spacing(3))] min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-accent/50"
      >
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-foreground/90">{title}</span>
        {attachment.subtitle ? (
          <span className="min-w-0 truncate text-muted-foreground">{attachment.subtitle}</span>
        ) : null}
        <ExternalLinkIcon aria-hidden className="ml-auto size-2.5 shrink-0 text-muted-foreground" />
      </button>
    </li>
  );
}

/** Parent, sub-issues, relations, and attachments, each section only when it has something. */
function IssueConnections({
  issue,
  onOpenIssue,
}: {
  issue: LinearIssue;
  onOpenIssue: (issue: LinearIssueRef) => void;
}) {
  const children = issue.children ?? [];
  const relations = issue.relations ?? [];
  const attachments = (issue.attachments ?? []).filter((attachment) => isWebUrl(attachment.url));
  const done = children.filter((child) => isEnded(child.state)).length;
  return (
    <>
      {children.length > 0 ? (
        <Section title="Sub-issues" detail={`${done}/${children.length} done`}>
          <IssueRefList issues={children} onOpen={onOpenIssue} />
        </Section>
      ) : null}
      {RELATION_GROUPS.map(({ kind, label }) => {
        const group = relations.filter((relation) => relation.kind === kind);
        return group.length > 0 ? (
          <Section key={kind} title={label}>
            <IssueRefList issues={group.map((relation) => relation.issue)} onOpen={onOpenIssue} />
          </Section>
        ) : null;
      })}
      {attachments.length > 0 ? (
        <Section title="Links">
          <ul className="mt-1">
            {attachments.map((attachment) => (
              <AttachmentRow key={attachment.url} attachment={attachment} />
            ))}
          </ul>
        </Section>
      ) : null}
    </>
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
  threadRef,
  issueId,
  onPosted,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef | null;
  issueId: string;
  onPosted: () => void;
}) {
  const draftKey = linearCommentDraftKey(environmentId, threadRef, issueId);
  const body = useLinearCommentDraftStore((state) => state.drafts[draftKey]?.body ?? "");
  const posting = useLinearCommentDraftStore((state) => state.drafts[draftKey]?.posting ?? false);
  const createComment = useAtomCommand(linearEnvironment.createComment, { reportFailure: false });
  const submit = async () => {
    const trimmed = useLinearCommentDraftStore.getState().beginPost(draftKey);
    if (trimmed === null) return;
    const result = await createComment({ environmentId, input: { issueId, body: trimmed } });
    useLinearCommentDraftStore.getState().finishPost(draftKey, result._tag === "Success");
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not post the comment" });
      return;
    }
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
        onChange={(event) =>
          useLinearCommentDraftStore.getState().setBody(draftKey, event.target.value)
        }
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
  // then re-read the fresh entry. A forced read that fails leaves the server's old entry in
  // place, so re-reading would show it as if fresh; say so instead.
  const refresh = useCallback(async () => {
    setRefreshing(true);
    const results = await Promise.all([
      readIssue({ environmentId, input: { identifier, refresh: true } }),
      readComments({ environmentId, input: { identifier, refresh: true } }),
    ]);
    const failure = results.find((result) => result._tag === "Failure");
    if (failure !== undefined) {
      toastManager.add({
        type: "error",
        title: `Could not refresh ${identifier}`,
        description: formatEnvironmentQueryError(failure.cause),
      });
    } else {
      refreshIssue();
      refreshComments();
    }
    setRefreshing(false);
  }, [environmentId, identifier, readComments, readIssue, refreshComments, refreshIssue]);
  // Issues named from this one live in the same workspace, so they open as tabs of their own
  // beside the thread. Without a thread to attach the tab to, Linear itself is the destination.
  const openIssue = useCallback(
    (ref: LinearIssueRef) => {
      if (threadRef === null) {
        openExternal(ref.url);
        return;
      }
      useRightPanelStore.getState().openLinearIssue(threadRef, ref.identifier);
    },
    [threadRef],
  );

  if (!supported) {
    return (
      <LinearUnavailable
        title="Linear issues unavailable"
        description="Update this environment's T3 Code server to open Linear issues here."
        identifier={identifier}
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
        identifier={identifier}
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
      <div className="@container/linear-issue min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {issue === null ? (
          <p className="text-xs text-muted-foreground">Loading issue…</p>
        ) : (
          <>
            {issue.parent ? (
              <button
                type="button"
                onClick={() => openIssue(issue.parent!)}
                className="mb-1.5 flex max-w-full min-w-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                <CornerLeftUpIcon aria-hidden className="size-3 shrink-0" />
                <span className="shrink-0 font-medium">{issue.parent.identifier}</span>
                <span className="min-w-0 truncate">{issue.parent.title}</span>
              </button>
            ) : null}
            <h1 className="text-base font-semibold leading-snug text-pretty">{issue.title}</h1>
            <PropertyChips issue={issue} />
            {issue.labels.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {issue.labels.map((label) => (
                  <LinearLabelPill key={label.name} label={label} />
                ))}
              </div>
            ) : null}
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
            <IssueDetails issue={issue} />
            <IssueConnections issue={issue} onOpenIssue={openIssue} />
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
              threadRef={threadRef}
              issueId={issue.id}
              onPosted={refreshComments}
            />
          </>
        )}
      </div>
    </div>
  );
}
