import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { LINEAR_ISSUE_NUMBER_SOURCE, LINEAR_TEAM_KEY_SOURCE } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { type MouseEvent, useCallback } from "react";

import { useRightPanelStore } from "../rightPanelStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useServerConfigs } from "../state/entities";
import { linearEnvironment } from "../state/linear";

/**
 * `/<workspace>/issue/<KEY-123>[/slug]`, and the workspace-less `/issue/<KEY-123>` Linear
 * redirects to it. The autolinker writes the short form, so the panel has to open from both.
 */
const LINEAR_ISSUE_PATH_PATTERN = new RegExp(
  `^(?:/([^/]+))?/issue/(${LINEAR_TEAM_KEY_SOURCE}-${LINEAR_ISSUE_NUMBER_SOURCE})(?:/|$)`,
  "iu",
);

export interface LinearIssueLink {
  readonly identifier: string;
  /** The workspace slug the URL named, lower case, or null for the short form. */
  readonly workspace: string | null;
}

/** The issue a `linear.app` URL names, or null for anything else on that host. */
export function parseLinearIssueUrl(url: string): LinearIssueLink | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "linear.app") return null;
  const match = LINEAR_ISSUE_PATH_PATTERN.exec(parsed.pathname);
  if (match === null) return null;
  return { identifier: match[2]!.toUpperCase(), workspace: match[1]?.toLowerCase() ?? null };
}

export function environmentReadsLinearIssues(
  serverConfigs: ReturnType<typeof useServerConfigs>,
  environmentId: EnvironmentId,
): boolean {
  return serverConfigs.get(environmentId)?.environment.capabilities.linearIssues === true;
}

/**
 * Whether the environment's key can read the workspace a link names. The key reads exactly one
 * workspace, and an identifier from another may collide with an unrelated issue there, so a
 * link that names a different workspace stays the ordinary external link it was. Until the
 * status has been read, or for the workspace-less form, the link is given the benefit of the
 * doubt: the panel's own not-found state is the fallback then.
 */
export function environmentCanOpenLinearLink(
  environmentId: EnvironmentId,
  link: LinearIssueLink,
): boolean {
  if (link.workspace === null) return true;
  const status = Option.getOrNull(
    AsyncResult.value(appAtomRegistry.get(linearEnvironment.status({ environmentId, input: {} }))),
  );
  const urlKey = status?.workspace?.urlKey;
  return urlKey === undefined || urlKey.toLowerCase() === link.workspace;
}

type LinkClickEvent = Pick<
  MouseEvent<HTMLElement>,
  "preventDefault" | "stopPropagation" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"
>;

/**
 * Opens a Linear issue link as a right-panel tab beside the thread. Returns false, leaving the
 * default navigation alone, for non-issue URLs, any modifier click (the reader's way out to the
 * browser), links into another workspace, and environments without the capability.
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
      const { environmentId } = resolvedThreadRef;
      if (!environmentReadsLinearIssues(serverConfigs, environmentId)) return false;
      if (!environmentCanOpenLinearLink(environmentId, parsed)) return false;
      event.preventDefault();
      event.stopPropagation();
      useRightPanelStore.getState().openLinearIssue(resolvedThreadRef, parsed.identifier);
      return true;
    },
    [serverConfigs, threadRef],
  );
}
