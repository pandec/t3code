export interface DraftSubmissionTracker {
  begin: (draftId: string) => void;
  finish: (draftId: string, succeeded: boolean) => void;
  hasStarted: (draftId: string) => boolean;
  clear: (draftId: string) => void;
}

export function createDraftSubmissionTracker(): DraftSubmissionTracker {
  const startedDraftIds = new Set<string>();

  return {
    begin: (draftId) => {
      startedDraftIds.add(draftId);
    },
    finish: (draftId, succeeded) => {
      if (!succeeded) {
        startedDraftIds.delete(draftId);
      }
    },
    hasStarted: (draftId) => startedDraftIds.has(draftId),
    clear: (draftId) => {
      startedDraftIds.delete(draftId);
    },
  };
}

export const draftSubmissionTracker = createDraftSubmissionTracker();
