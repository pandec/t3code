import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  DesktopThreadLink,
  EnvironmentId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";

/** Stands in for the primary environment's id, which tools outside the app cannot know. */
export const PRIMARY_ENVIRONMENT_LINK_ALIAS = "primary";

export type DesktopThreadLinkResolution =
  | { readonly kind: "open"; readonly threadRef: ScopedThreadRef }
  | { readonly kind: "environment-not-found" }
  | { readonly kind: "environment-unavailable" }
  | { readonly kind: "thread-not-found" };

export interface DesktopThreadLinkDependencies {
  readonly isKnownEnvironment: (environmentId: EnvironmentId) => boolean;
  readonly primaryEnvironmentId: () => EnvironmentId | null;
  /** Resolves false when the environment's thread list does not go live in time. */
  readonly waitForThreadList: (environmentId: EnvironmentId) => Promise<boolean>;
  readonly hasActiveThread: (threadRef: ScopedThreadRef) => boolean;
  /** Resolves null when the environment's archive cannot be read. */
  readonly hasArchivedThread: (threadRef: ScopedThreadRef) => Promise<boolean | null>;
}

function resolveEnvironmentId(
  linkEnvironmentId: string,
  dependencies: DesktopThreadLinkDependencies,
): EnvironmentId | null {
  const environmentId = linkEnvironmentId as EnvironmentId;
  if (dependencies.isKnownEnvironment(environmentId)) return environmentId;
  if (linkEnvironmentId !== PRIMARY_ENVIRONMENT_LINK_ALIAS) return null;
  return dependencies.primaryEnvironmentId();
}

/** Finds the thread a desktop link points at, active or archived. */
export async function resolveDesktopThreadLink(
  link: DesktopThreadLink,
  dependencies: DesktopThreadLinkDependencies,
): Promise<DesktopThreadLinkResolution> {
  const environmentId = resolveEnvironmentId(link.environmentId, dependencies);
  if (environmentId === null) return { kind: "environment-not-found" };
  if (!(await dependencies.waitForThreadList(environmentId))) {
    return { kind: "environment-unavailable" };
  }
  const threadRef = scopeThreadRef(environmentId, link.threadId as ThreadId);
  if (dependencies.hasActiveThread(threadRef)) return { kind: "open", threadRef };
  // Archived threads have no shell, so only the archive knows about them.
  const archived = await dependencies.hasArchivedThread(threadRef);
  if (archived === null) return { kind: "environment-unavailable" };
  // The thread may have been unarchived while the archive was loading.
  return archived || dependencies.hasActiveThread(threadRef)
    ? { kind: "open", threadRef }
    : { kind: "thread-not-found" };
}
