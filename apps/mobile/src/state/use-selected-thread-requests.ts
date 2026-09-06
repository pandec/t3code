import { derivePendingRequests } from "@t3tools/client-runtime/pending-requests";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useMemo, useState } from "react";

import {
  ApprovalRequestId,
  type ProviderApprovalDecision,
  type UserInputQuestion,
} from "@t3tools/contracts";

import { threadEnvironment } from "../state/threads";
import { scopedRequestKey } from "../lib/scopedEntities";
import { buildPendingUserInputAnswers } from "../lib/threadActivity";
import {
  readPendingUserInputAnswersSnapshot,
  setUserInputDraftCustomAnswer,
  setUserInputDraftOption,
  userInputDraftsByRequestKeyAtom,
} from "./pending-user-input-drafts";
import { useSelectedThreadDetail } from "./use-thread-detail";
import { useThreadSelection } from "./use-thread-selection";
import { useAtomCommand } from "./use-atom-command";

export function useSelectedThreadRequests() {
  const respondToApproval = useAtomCommand(
    threadEnvironment.respondToApproval,
    "thread approval response",
  );
  const respondToUserInput = useAtomCommand(
    threadEnvironment.respondToUserInput,
    "thread user input response",
  );
  const { selectedThread: selectedThreadShell } = useThreadSelection();
  const selectedThread = useSelectedThreadDetail();
  const userInputDraftsByRequestKey = useAtomValue(userInputDraftsByRequestKeyAtom);
  const [respondingApprovalId, setRespondingApprovalId] = useState<ApprovalRequestId | null>(null);
  const [respondingUserInputId, setRespondingUserInputId] = useState<ApprovalRequestId | null>(
    null,
  );

  const { approvals: activePendingApprovals, userInputs: activePendingUserInputs } = useMemo(
    () => derivePendingRequests(selectedThread?.activities ?? []),
    [selectedThread?.activities],
  );
  const activePendingApproval = activePendingApprovals[0] ?? null;
  const activePendingUserInput = activePendingUserInputs[0] ?? null;
  const activePendingUserInputDrafts =
    activePendingUserInput && selectedThreadShell
      ? (userInputDraftsByRequestKey[
          scopedRequestKey(selectedThreadShell.environmentId, activePendingUserInput.requestId)
        ] ?? {})
      : {};
  const activePendingUserInputAnswers = activePendingUserInput
    ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingUserInputDrafts)
    : null;

  const onSelectUserInputOption = useCallback(
    (requestId: ApprovalRequestId, question: UserInputQuestion, value: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const requestKey = scopedRequestKey(selectedThreadShell.environmentId, requestId);
      setUserInputDraftOption(requestKey, question, value);
    },
    [selectedThreadShell],
  );

  const onChangeUserInputCustomAnswer = useCallback(
    (requestId: ApprovalRequestId, questionId: string, customAnswer: string) => {
      const question = activePendingUserInputs
        .find((request) => request.requestId === requestId)
        ?.questions.find((entry) => entry.id === questionId);
      if (!selectedThreadShell || !question) {
        return;
      }

      const requestKey = scopedRequestKey(selectedThreadShell.environmentId, requestId);
      setUserInputDraftCustomAnswer(requestKey, question, customAnswer);
    },
    [activePendingUserInputs, selectedThreadShell],
  );

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      if (!selectedThreadShell) {
        return;
      }

      setRespondingApprovalId(requestId);
      const result = await respondToApproval({
        environmentId: selectedThreadShell.environmentId,
        input: {
          threadId: selectedThreadShell.id,
          requestId,
          decision,
        },
      });
      setRespondingApprovalId((current) => (current === requestId ? null : current));
      return result;
    },
    [respondToApproval, selectedThreadShell],
  );

  const onSubmitUserInput = useCallback(async () => {
    if (!selectedThreadShell || !activePendingUserInput) {
      return;
    }
    const answers = readPendingUserInputAnswersSnapshot(
      selectedThreadShell.environmentId,
      activePendingUserInput,
    );
    if (!answers) {
      return;
    }

    const requestId = activePendingUserInput.requestId;
    setRespondingUserInputId(requestId);
    const result = await respondToUserInput({
      environmentId: selectedThreadShell.environmentId,
      input: {
        threadId: selectedThreadShell.id,
        requestId,
        answers,
      },
    });
    setRespondingUserInputId((current) => (current === requestId ? null : current));
    return result;
  }, [activePendingUserInput, respondToUserInput, selectedThreadShell]);

  return {
    activePendingApproval,
    activePendingUserInput,
    activePendingUserInputDrafts,
    activePendingUserInputAnswers,
    respondingApprovalId,
    respondingUserInputId,
    onRespondToApproval,
    onSelectUserInputOption,
    onChangeUserInputCustomAnswer,
    onSubmitUserInput,
  };
}
