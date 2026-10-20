import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadState } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import type { DraftId } from "./composerDraftStore";

export type ThreadRouteTarget =
  | {
      kind: "server";
      threadRef: ScopedThreadRef;
    }
  | {
      kind: "draft";
      draftId: DraftId;
    };

type DraftThreadRouteState = {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  promotedTo?: ScopedThreadRef | null;
};

export type ThreadRouteRenderState = "loading" | "ready" | "missing";

export function isThreadRouteSnapshotAuthoritative(
  status: EnvironmentShellStatus | null | undefined,
): boolean {
  return status === "live";
}

export function resolveThreadRouteRenderState(input: {
  bootstrapComplete: boolean;
  serverThreadExists: boolean;
  serverThreadDeleted: boolean;
  /** Fork: absent for split panes, which resolve the detail through `archivedThread`. */
  unlistedThreadDetail?: EnvironmentThreadState;
  draftThreadExists: boolean;
  /** Fork: what the detail says when the active shell lacks the thread. */
  archivedThread?: ThreadRouteRenderState;
}): ThreadRouteRenderState {
  if (
    input.draftThreadExists ||
    (input.serverThreadExists && !input.serverThreadDeleted) ||
    input.archivedThread === "ready"
  ) {
    return "ready";
  }
  if (!input.bootstrapComplete) {
    return "loading";
  }
  if (input.serverThreadExists || input.unlistedThreadDetail?.status === "deleted") {
    return "missing";
  }
  if (input.unlistedThreadDetail === undefined) {
    return input.archivedThread ?? "missing";
  }
  // Shell membership can lag a new thread; its detail decides. Fork: an
  // archived detail already opened through `archivedThread` above.
  const projection = Option.getOrNull(input.unlistedThreadDetail.data);
  if (projection === null) {
    return "loading";
  }
  return projection.thread.deletedAt !== null || projection.thread.archivedAt !== null
    ? "missing"
    : "ready";
}

/**
 * Fork: a thread the active shell does not hold may be archived. Its detail
 * opens it while archived; a detail that is not archived (yet) waits for the
 * shell that is about to carry it, and only a deleted or unknown thread
 * (the snapshot loader's definitive 404) is missing.
 */
export function resolveArchivedThreadRouteState(input: {
  readonly detail: { readonly archived: boolean; readonly deleted: boolean } | null;
  readonly status: EnvironmentThreadStatus;
}): ThreadRouteRenderState {
  if (input.status === "deleted" || input.detail?.deleted === true) {
    return "missing";
  }
  return input.detail?.archived === true ? "ready" : "loading";
}

export function buildThreadRouteParams(ref: ScopedThreadRef): {
  environmentId: EnvironmentId;
  threadId: ThreadId;
} {
  return {
    environmentId: ref.environmentId,
    threadId: ref.threadId,
  };
}

/** Whether a (decoded) location pathname is `ref`'s own thread route, `/$environmentId/$threadId`. */
export function isThreadRoutePathname(pathname: string, ref: ScopedThreadRef): boolean {
  const { environmentId, threadId } = buildThreadRouteParams(ref);
  return pathname.replace(/\/$/, "") === `/${environmentId}/${threadId}`;
}

export function buildDraftThreadRouteParams(draftId: DraftId): {
  draftId: DraftId;
} {
  return { draftId };
}

export function resolveThreadRouteRef(
  params: Partial<Record<"environmentId" | "threadId", string | undefined>>,
): ScopedThreadRef | null {
  if (!params.environmentId || !params.threadId) {
    return null;
  }

  return scopeThreadRef(params.environmentId as EnvironmentId, params.threadId as ThreadId);
}

export function resolveThreadRouteTarget(
  params: Partial<Record<"environmentId" | "threadId" | "draftId", string | undefined>>,
): ThreadRouteTarget | null {
  if (params.environmentId && params.threadId) {
    return {
      kind: "server",
      threadRef: scopeThreadRef(params.environmentId as EnvironmentId, params.threadId as ThreadId),
    };
  }

  if (!params.draftId) {
    return null;
  }

  return {
    kind: "draft",
    draftId: params.draftId as DraftId,
  };
}

export function resolveActiveThreadRouteRef(
  target: ThreadRouteTarget | null,
  draftThread: DraftThreadRouteState | null,
): ScopedThreadRef | null {
  if (target?.kind === "server") {
    return target.threadRef;
  }
  if (target?.kind !== "draft" || !draftThread?.promotedTo) {
    return null;
  }
  return draftThread.promotedTo;
}
