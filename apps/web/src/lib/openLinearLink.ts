import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { LINEAR_ISSUE_NUMBER_SOURCE, LINEAR_TEAM_KEY_SOURCE } from "@t3tools/contracts";
import { type MouseEvent, useCallback } from "react";

import { useRightPanelStore } from "../rightPanelStore";
import { useServerConfigs } from "../state/entities";

/**
 * `/<workspace>/issue/<KEY-123>[/slug]`, and the workspace-less `/issue/<KEY-123>` Linear
 * redirects to it. The autolinker writes the short form, so the panel has to open from both.
 */
const LINEAR_ISSUE_PATH_PATTERN = new RegExp(
  `^(?:/[^/]+)?/issue/(${LINEAR_TEAM_KEY_SOURCE}-${LINEAR_ISSUE_NUMBER_SOURCE})(?:/|$)`,
  "iu",
);

/** The issue identifier a `linear.app` URL names, or null for anything else on that host. */
export function parseLinearIssueUrl(url: string): { readonly identifier: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "linear.app") return null;
  const match = LINEAR_ISSUE_PATH_PATTERN.exec(parsed.pathname);
  if (match === null) return null;
  return { identifier: match[1]!.toUpperCase() };
}

export function environmentReadsLinearIssues(
  serverConfigs: ReturnType<typeof useServerConfigs>,
  environmentId: EnvironmentId,
): boolean {
  return serverConfigs.get(environmentId)?.environment.capabilities.linearIssues === true;
}

type LinkClickEvent = Pick<
  MouseEvent<HTMLElement>,
  "preventDefault" | "stopPropagation" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"
>;

/**
 * Opens a Linear issue link as a right-panel tab beside the thread. Returns false, leaving the
 * default navigation alone, for non-issue URLs, any modifier click (the reader's way out to the
 * browser), and environments without the capability.
 */
export function useOpenLinearIssueLink(
  threadRef?: ScopedThreadRef,
): (event: LinkClickEvent, targetUrl: string, targetThreadRef?: ScopedThreadRef) => boolean {
  const serverConfigs = useServerConfigs();
  return useCallback(
    (event, targetUrl, targetThreadRef) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
      const resolvedThreadRef = targetThreadRef ?? threadRef;
      if (resolvedThreadRef === undefined) return false;
      const parsed = parseLinearIssueUrl(targetUrl);
      if (parsed === null) return false;
      if (!environmentReadsLinearIssues(serverConfigs, resolvedThreadRef.environmentId))
        return false;
      event.preventDefault();
      event.stopPropagation();
      useRightPanelStore.getState().openLinearIssue(resolvedThreadRef, parsed.identifier);
      return true;
    },
    [serverConfigs, threadRef],
  );
}
