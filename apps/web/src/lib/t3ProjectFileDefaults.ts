import { T3_PROJECT_FILE_NAME, type EnvironmentId, type T3ProjectFile } from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";

/** The disconnected file query can suspend indefinitely, so New Thread bounds its read. */
export const T3_PROJECT_FILE_READ_TIMEOUT_MS = 1_500;

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

async function readProjectFileQuery(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<T3ProjectFile | null> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    getProjectFileQueryAtom(environmentId, workspaceRoot, T3_PROJECT_FILE_NAME),
    { reportDefect: false, reportFailure: false },
  );
  const data = resolveProjectFileQueryData(
    environmentId,
    workspaceRoot,
    T3_PROJECT_FILE_NAME,
    result._tag === "Success" ? result.value : null,
  );
  if (data === null || data.truncated) return null;
  return parseT3ProjectFile(data.contents);
}

/** Read t3.json at draft creation, treating missing, invalid or timed-out reads as absent. */
export function readT3ProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<T3ProjectFile | null> {
  return boundedProjectFileRead(readProjectFileQuery(environmentId, workspaceRoot));
}
