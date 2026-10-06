import type { ThreadUserInputQuestion } from "@t3tools/client-runtime/state/thread-requests";
import { Atom } from "effect/reactivity";

import {
  buildPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../lib/threadActivity";
import { appAtomRegistry } from "./atom-registry";

/** Typed answers to pending agent questions, keyed by `scopedRequestKey`, then question id. */
export const userInputDraftsByRequestKeyAtom = Atom.make<
  Record<string, Record<string, PendingUserInputDraftAnswer>>
>({}).pipe(Atom.keepAlive, Atom.withLabel("mobile:user-input-drafts"));

export function setUserInputDraftOption(
  requestKey: string,
  question: ThreadUserInputQuestion,
  value: string,
): void {
  const current = appAtomRegistry.get(userInputDraftsByRequestKeyAtom);
  appAtomRegistry.set(userInputDraftsByRequestKeyAtom, {
    ...current,
    [requestKey]: {
      ...current[requestKey],
      [question.id]: togglePendingUserInputOptionSelection(
        question,
        current[requestKey]?.[question.id],
        value,
      ),
    },
  });
}

export function setUserInputDraftCustomAnswer(
  requestKey: string,
  question: ThreadUserInputQuestion,
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

/**
 * Builds the answers to submit from the typed answers as they are now, not as
 * the last render saw them: a submit fired in the same tick as the final
 * keystroke would otherwise send the previous text. Attachment state still
 * comes from the rendered drafts; the submit path re-checks it before sending.
 */
export function readLatestPendingUserInputAnswers(
  requestKey: string,
  questions: ReadonlyArray<ThreadUserInputQuestion>,
  renderedDrafts: Readonly<Record<string, PendingUserInputDraftAnswer>>,
): Record<string, string | ReadonlyArray<string>> | null {
  const typed = appAtomRegistry.get(userInputDraftsByRequestKeyAtom)[requestKey] ?? {};
  return buildPendingUserInputAnswers(
    questions,
    Object.fromEntries(
      questions.map((question) => {
        const rendered = renderedDrafts[question.id];
        return [
          question.id,
          {
            ...typed[question.id],
            ...(rendered?.attachmentCount !== undefined
              ? { attachmentCount: rendered.attachmentCount }
              : {}),
            ...(rendered?.attachmentsBlocked !== undefined
              ? { attachmentsBlocked: rendered.attachmentsBlocked }
              : {}),
          },
        ];
      }),
    ),
  );
}
