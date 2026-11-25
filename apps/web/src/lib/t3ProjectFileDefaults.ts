import {
  T3_PROJECT_FILE_NAME,
  type EnvironmentId,
  type ProjectReadFileResult,
  type T3ProjectFile,
} from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";

/** The disconnected file query can suspend indefinitely, so New Thread bounds its read. */
const T3_PROJECT_FILE_READ_TIMEOUT_MS = 1_500;

export function boundedProjectFileRead(
  read: Promise<T3ProjectFile | null>,
  timeoutMs: number = T3_PROJECT_FILE_READ_TIMEOUT_MS,
): Promise<T3ProjectFile | null> {
  return Effect.runPromise(
    Effect.promise(() => read).pipe(
      Effect.timeoutOption(Duration.millis(timeoutMs)),
      Effect.map(Option.getOrNull),
    ),
  );
}

function toT3ProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  result: ProjectReadFileResult | null,
): T3ProjectFile | null {
  const data = resolveProjectFileQueryData(
    environmentId,
    workspaceRoot,
    T3_PROJECT_FILE_NAME,
    result,
  );
  if (data === null || data.exists === false || data.truncated) return null;
  return parseT3ProjectFile(data.contents);
}

async function readProjectFileQuery(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<T3ProjectFile | null> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    getProjectFileQueryAtom(environmentId, workspaceRoot, T3_PROJECT_FILE_NAME),
    { reportDefect: false, reportFailure: false },
  );
  return toT3ProjectFile(
    environmentId,
    workspaceRoot,
    result._tag === "Success" ? result.value : null,
  );
}

/** The project's t3.json from an earlier read, or `undefined` when none has loaded yet. */
export function peekT3ProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): T3ProjectFile | null | undefined {
  const result = appAtomRegistry.get(
    getProjectFileQueryAtom(environmentId, workspaceRoot, T3_PROJECT_FILE_NAME),
  );
  return AsyncResult.isSuccess(result)
    ? toT3ProjectFile(environmentId, workspaceRoot, result.value)
    : undefined;
}

/** Read t3.json at draft creation, treating missing, invalid or timed-out reads as absent. */
export function readT3ProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<T3ProjectFile | null> {
  return boundedProjectFileRead(readProjectFileQuery(environmentId, workspaceRoot));
}
