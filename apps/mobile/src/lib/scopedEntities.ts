import { scopedThreadKey as sharedScopedThreadKey } from "@t3tools/client-runtime/state/thread-outbox-model";
import { ApprovalRequestId, EnvironmentId, ProjectId } from "@t3tools/contracts";

export function scopedProjectKey(environmentId: EnvironmentId, projectId: ProjectId): string {
  return `${environmentId}:${projectId}`;
}

export const scopedThreadKey = sharedScopedThreadKey;

export function isServerThreadDraftKey(draftKey: string): boolean {
  return !draftKey.startsWith("new-task:") && !draftKey.startsWith("pending-task:");
}

export function scopedRequestKey(
  environmentId: EnvironmentId,
  requestId: ApprovalRequestId,
): string {
  return `${environmentId}:${requestId}`;
}
