import { useAtomValue } from "@effect/atom-react";
import { createLinearEnvironmentAtoms } from "@t3tools/client-runtime/state/linear";
import { LinearRpcError, type LinearRpcErrorReason } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

export const linearEnvironment = createLinearEnvironmentAtoms(connectionAtomRuntime);

const isLinearRpcError = Schema.is(LinearRpcError);
const EMPTY_RESULT_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("web-linear:failure-reason:empty"),
);

/**
 * The typed reason behind a failed Linear read, or null while it is loading, succeeded, or
 * failed some other way. The panel picks its copy on this rather than on the message text the
 * server happens to send.
 */
export function useLinearFailureReason(
  atom: Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>> | null,
): LinearRpcErrorReason | null {
  const result = useAtomValue(atom ?? EMPTY_RESULT_ATOM);
  if (result._tag !== "Failure") return null;
  const error = Cause.squash(result.cause);
  return isLinearRpcError(error) ? error.reason : null;
}
