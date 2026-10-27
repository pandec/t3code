import { afterEach, describe, expect, it } from "vite-plus/test";
import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import {
  type ThreadUserInputQuestion,
  userInputDraftKey,
} from "@t3tools/client-runtime/state/thread-requests";

import { appAtomRegistry } from "./atom-registry";
import {
  readLatestPendingUserInputAnswers,
  setUserInputDraftCustomAnswer,
  userInputDraftsByRequestKeyAtom,
} from "./pending-user-input-drafts";

const requestKey = userInputDraftKey(
  EnvironmentId.make("environment-1"),
  ThreadId.make("thread-1"),
  RuntimeRequestId.make("request-1"),
);
const question: ThreadUserInputQuestion = {
  id: "details",
  header: "Details",
  question: "What should change?",
  options: [],
  multiSelect: false,
};

afterEach(() => {
  appAtomRegistry.set(userInputDraftsByRequestKeyAtom, {});
});

describe("latest pending user input answers", () => {
  it("submits the answer typed after the last render", () => {
    setUserInputDraftCustomAnswer(requestKey, question, "First answer");
    const rendered = appAtomRegistry.get(userInputDraftsByRequestKeyAtom)[requestKey] ?? {};
    setUserInputDraftCustomAnswer(requestKey, question, "Latest answer");

    expect(readLatestPendingUserInputAnswers(requestKey, [question], rendered)).toEqual({
      details: "Latest answer",
    });
  });

  it("keeps the rendered attachment guard", () => {
    setUserInputDraftCustomAnswer(requestKey, question, "Answer");

    expect(
      readLatestPendingUserInputAnswers(requestKey, [question], {
        details: { attachmentCount: 1, attachmentsBlocked: true },
      }),
    ).toBeNull();
    expect(
      readLatestPendingUserInputAnswers(requestKey, [question], {
        details: { attachmentCount: 1, attachmentsBlocked: false },
      }),
    ).toEqual({ details: "Answer" });
  });
});
