// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { OrchestrationGetWorkflowScriptError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { readContainedWorkflowFile } from "./workflowFileRead.ts";

/** The default Claude projects root under the given home directory. */
export function defaultScriptsRoot(home: string): string {
  return NodePath.join(home, ".claude", "projects");
}

export const readWorkflowScript = Effect.fn("orchestration.readWorkflowScript")(function* (input: {
  readonly scriptPath: string;
  /**
   * Fork: absolute Claude projects roots the script may live under: ~/.claude/projects plus the
   * projects dir of every configured Claude instance's config dir (shadow homes symlink
   * `projects` back to their shared dir, so realpath containment covers them). Always
   * server-derived (never client input); defaults to ~/.claude/projects.
   */
  readonly permittedRoots?: ReadonlyArray<string>;
}) {
  const file = yield* readContainedWorkflowFile({
    path: input.scriptPath,
    extension: ".js",
    byteCap: 256 * 1024,
    ...(input.permittedRoots === undefined ? {} : { roots: input.permittedRoots }),
  }).pipe(
    Effect.mapError(
      (error) =>
        new OrchestrationGetWorkflowScriptError({
          reason: error.reason === "wrong-extension" ? "not-js" : error.reason,
          scriptPath: error.path,
          cause: error,
        }),
    ),
  );
  return { scriptPath: file.path, contents: file.contents, truncated: file.truncated };
});
