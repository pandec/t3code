import { T3_PROJECT_FILE_NAME, type EnvironmentId, type ThreadEnvMode } from "@t3tools/contracts";
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

/**
 * Deadline for the new-thread t3.json read. The file query atom gates on a
 * connected RPC generation and suspends indefinitely (`Effect.never`) while
 * the environment is offline, so an unbounded await would make New Thread
 * hang forever. When the deadline passes the file simply contributes
 * nothing and env-mode resolution falls through to the global default —
 * trading a possibly-missed checked-in default for a New Thread button
 * that always responds.
 */
export const T3_PROJECT_FILE_READ_TIMEOUT_MS = 1_500;

/**
 * Bounds a project-file default read against the new-thread deadline,
 * treating a timeout as "no file" (null). Exported seam for tests;
 * `readT3ProjectFileDefaultThreadEnvMode` is the production composition.
 */
export function boundedDefaultThreadEnvModeRead(
  read: Promise<ThreadEnvMode | null>,
  timeoutMs: number = T3_PROJECT_FILE_READ_TIMEOUT_MS,
): Promise<ThreadEnvMode | null> {
  return Effect.runPromise(
    Effect.promise(() => read).pipe(
      Effect.timeoutOption(Duration.millis(timeoutMs)),
      Effect.map(Option.getOrNull),
    ),
  );
}

async function readDefaultThreadEnvModeFromProjectFileQuery(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<ThreadEnvMode | null> {
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
  return parseT3ProjectFile(data.contents)?.defaultThreadEnvMode ?? null;
}

/**
 * Read `defaultThreadEnvMode` from the project's checked-in `t3.json`.
 *
 * Imperative counterpart to `useT3ProjectFileScripts` for the new-thread
 * path, which resolves defaults at call time rather than render time. The
 * file query atom caches per (environment, cwd), so repeat calls don't
 * re-fetch. Optimistic in-app writes overlay the query result, matching what
 * `useProjectFileQuery` renders. Missing, truncated, or invalid files
 * resolve to null — as does a read that outlives the deadline above.
 */
export function readT3ProjectFileDefaultThreadEnvMode(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<ThreadEnvMode | null> {
  return boundedDefaultThreadEnvModeRead(
    readDefaultThreadEnvModeFromProjectFileQuery(environmentId, workspaceRoot),
  );
}
