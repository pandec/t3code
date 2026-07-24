export interface DraftSubmissionTracker {
  begin: (draftId: string) => void;
  end: (draftId: string) => void;
  isInFlight: (draftId: string) => boolean;
}

export function createDraftSubmissionTracker(): DraftSubmissionTracker {
  const inFlightDraftIds = new Set<string>();

  return {
    begin: (draftId) => {
      inFlightDraftIds.add(draftId);
    },
    end: (draftId) => {
      inFlightDraftIds.delete(draftId);
    },
    isInFlight: (draftId) => inFlightDraftIds.has(draftId),
  };
}

export const draftSubmissionTracker = createDraftSubmissionTracker();
