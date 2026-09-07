import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { cloneElement, useState, type ComponentPropsWithoutRef, type ReactElement } from "react";

import { formatRelativeTimeLabel } from "~/timestampFormat";
import { linearEnvironment } from "~/state/linear";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { useEnvironmentQuery } from "~/state/query";

import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";
import { LinearStateBadge, LinearUserAvatar, linearUserLabel } from "./linearPresentation";

type LinkElement = ReactElement<ComponentPropsWithoutRef<"a">>;

/**
 * Hover card for a Linear issue link. A bare `SP-123` autolink is only a guess at an issue, so
 * with `confirmBeforeOpen` the click resolves it first and falls back to the plain URL when Linear
 * has nothing by that name.
 */
export function LinearIssueLinkPreview({
  link,
  originalUrl,
  environmentId,
  identifier,
  confirmBeforeOpen,
  onOpenIssue,
  onOpenFallback,
}: {
  link: LinkElement;
  originalUrl: string;
  environmentId: EnvironmentId;
  identifier: string;
  confirmBeforeOpen: boolean;
  onOpenIssue: (url: string) => boolean;
  onOpenFallback: (url: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [resolvingClick, setResolvingClick] = useState(false);
  const target = { environmentId, input: { identifier } };
  const issueQuery = useEnvironmentQuery(open ? linearEnvironment.issue(target) : null);
  const readIssue = useAtomQueryRunner(linearEnvironment.issue, {
    reportFailure: false,
    reportDefect: false,
  });

  const trigger = confirmBeforeOpen
    ? cloneElement(link, {
        onClick: (event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          event.stopPropagation();
          if (resolvingClick) return;
          setOpen(false);
          setResolvingClick(true);
          void readIssue(target)
            .then(async (result) => {
              if (isAtomCommandInterrupted(result)) return;
              if (result._tag === "Success" && onOpenIssue(result.value.url)) return;
              await onOpenFallback(originalUrl);
            })
            .catch((error: unknown) => {
              console.error("[linear-issue-link-preview] failed to open link", error);
            })
            .finally(() => setResolvingClick(false));
        },
      })
    : link;
  const issue = issueQuery.data;

  return (
    <PreviewCard open={open} onOpenChange={setOpen}>
      <PreviewCardTrigger render={trigger} delay={350} closeDelay={120} />
      <PreviewCardPopup align="center" className="w-80 max-w-[calc(100vw-2rem)] p-3">
        {issue === null ? (
          <p className="text-xs leading-relaxed text-muted-foreground wrap-anywhere">
            {issueQuery.isPending ? "Loading issue details…" : (issueQuery.error ?? originalUrl)}
          </p>
        ) : (
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="shrink-0 font-medium">{issue.identifier}</span>
              <span aria-hidden>·</span>
              <LinearStateBadge state={issue.state} />
            </div>
            <p className="mt-1 text-sm font-medium leading-snug text-foreground text-pretty">
              {issue.title}
            </p>
            <div className="mt-2 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <LinearUserAvatar user={issue.assignee} />
              <span className="min-w-0 truncate">
                {linearUserLabel(issue.assignee, "Unassigned")}
              </span>
              <span aria-hidden>·</span>
              <span className="shrink-0">updated {formatRelativeTimeLabel(issue.updatedAt)}</span>
            </div>
          </div>
        )}
      </PreviewCardPopup>
    </PreviewCard>
  );
}
