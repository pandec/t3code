import { ApprovalRequestId, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

export function scopedProjectKey(environmentId: EnvironmentId, projectId: ProjectId): string {
  return `${environmentId}:${projectId}`;
}

export function scopedThreadKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return `${environmentId}:${threadId}`;
}

export function isServerThreadDraftKey(draftKey: string): boolean {
  return !draftKey.startsWith("new-task:") && !draftKey.startsWith("pending-task:");
}

export function scopedRequestKey(
  environmentId: EnvironmentId,
  requestId: ApprovalRequestId,
): string {
  return `${environmentId}:${requestId}`;
}
