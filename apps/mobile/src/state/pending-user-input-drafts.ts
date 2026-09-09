import type { EnvironmentId, UserInputQuestion } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import {
  buildPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInput,
  type PendingUserInputDraftAnswer,
} from "../lib/threadActivity";
import { scopedRequestKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";

export const userInputDraftsByRequestKeyAtom = Atom.make<
  Record<string, Record<string, PendingUserInputDraftAnswer>>
>({}).pipe(Atom.keepAlive, Atom.withLabel("mobile:user-input-drafts"));

export function setUserInputDraftOption(
  requestKey: string,
  question: UserInputQuestion,
  label: string,
): void {
  const current = appAtomRegistry.get(userInputDraftsByRequestKeyAtom);
  appAtomRegistry.set(userInputDraftsByRequestKeyAtom, {
    ...current,
    [requestKey]: {
      ...current[requestKey],
      [question.id]: togglePendingUserInputOptionSelection(
        question,
        current[requestKey]?.[question.id],
        label,
      ),
    },
  });
}

export function setUserInputDraftCustomAnswer(
  requestKey: string,
  question: UserInputQuestion,
  customAnswer: string,
): void {
  const current = appAtomRegistry.get(userInputDraftsByRequestKeyAtom);
  appAtomRegistry.set(userInputDraftsByRequestKeyAtom, {
    ...current,
    [requestKey]: {
      ...current[requestKey],
      [question.id]: setPendingUserInputCustomAnswer(
        question,
        current[requestKey]?.[question.id],
        customAnswer,
      ),
    },
  });
}

export function readPendingUserInputAnswersSnapshot(
  environmentId: EnvironmentId,
  pendingUserInput: PendingUserInput,
): Record<string, string | ReadonlyArray<string>> | null {
  const requestKey = scopedRequestKey(environmentId, pendingUserInput.requestId);
  const drafts = appAtomRegistry.get(userInputDraftsByRequestKeyAtom)[requestKey] ?? {};
  return buildPendingUserInputAnswers(pendingUserInput.questions, drafts);
}
