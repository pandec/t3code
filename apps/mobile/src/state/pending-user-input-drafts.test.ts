import { ApprovalRequestId, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  readPendingUserInputAnswersSnapshot,
  setUserInputDraftCustomAnswer,
} from "./pending-user-input-drafts";
import { scopedRequestKey } from "../lib/scopedEntities";

const environmentId = EnvironmentId.make("pending-input-snapshot-env");
const pendingUserInput = {
  requestId: ApprovalRequestId.make("pending-input-snapshot-request"),
  createdAt: "2026-08-11T00:00:00.000Z",
  questions: [
    {
      id: "details",
      header: "Details",
      question: "What should change?",
      options: [],
      multiSelect: false,
    },
  ],
} as const;

describe("pending user input draft snapshots", () => {
  it("reads the latest atom value at submission time", () => {
    const requestKey = scopedRequestKey(environmentId, pendingUserInput.requestId);
    setUserInputDraftCustomAnswer(requestKey, "details", "First answer");
    const renderedAnswers = readPendingUserInputAnswersSnapshot(environmentId, pendingUserInput);

    setUserInputDraftCustomAnswer(requestKey, "details", "Latest answer");
    const submittedAnswers = readPendingUserInputAnswersSnapshot(environmentId, pendingUserInput);

    expect(renderedAnswers).toEqual({ details: "First answer" });
    expect(submittedAnswers).toEqual({ details: "Latest answer" });
  });
});
