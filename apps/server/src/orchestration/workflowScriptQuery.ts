// @effect-diagnostics nodeBuiltinImport:off
/**
 * Read-only access to persisted workflow scripts for the Agents surface's
 * "{} script" affordance.
 *
 * Containment rules (lifted from the reviewed #3650 inspection service):
 * - the resolved realpath must live under a Claude projects root (where the
 *   Claude harness persists workflow scripts) — realpath re-containment
 *   defeats symlink escapes, including a symlinked leaf file. The permitted
 *   roots are server-configured: ~/.claude/projects plus the projects dir of
 *   every configured Claude instance's config dir (custom homes; shadow
 *   homes symlink `projects` back to their shared dir, so realpath
 *   containment under the shared root covers them);
 * - only .js leaf files are served;
 * - reads are size-capped rather than failed, with a truncation marker.
 *
 * The client-supplied path is a hint from the workflow's runHandles; it is
 * never trusted beyond these checks.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { OrchestrationGetWorkflowScriptError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

const SCRIPT_BYTE_CAP = 256 * 1024;

export function defaultScriptsRoot(): string {
  return NodePath.join(NodeOS.homedir(), ".claude", "projects");
}

export const readWorkflowScript = Effect.fn("orchestration.readWorkflowScript")(function* (input: {
  readonly scriptPath: string;
  /**
   * Absolute Claude projects roots the script may live under. Always
   * server-derived (never client input); defaults to ~/.claude/projects.
   */
  readonly permittedRoots?: ReadonlyArray<string>;
}) {
  const requested = input.scriptPath;

  if (!NodePath.isAbsolute(requested) || NodePath.extname(requested) !== ".js") {
    return yield* Effect.fail(
      new OrchestrationGetWorkflowScriptError({ reason: "invalid-path", scriptPath: requested }),
    );
  }

  const rootCandidates =
    input.permittedRoots !== undefined && input.permittedRoots.length > 0
      ? input.permittedRoots
      : [defaultScriptsRoot()];
  // A configured root that does not exist (e.g. a Claude home that has never
  // persisted a project) is skipped rather than failing the read; only when
  // every root is unavailable does the query fail.
  const roots = yield* Effect.promise(() =>
    Promise.all(
      rootCandidates.map((candidate) => NodeFSP.realpath(candidate).catch(() => undefined)),
    ),
  ).pipe(Effect.map((resolvedRoots) => resolvedRoots.filter((r): r is string => r !== undefined)));
  if (roots.length === 0) {
    return yield* Effect.fail(
      new OrchestrationGetWorkflowScriptError({
        reason: "root-unavailable",
        scriptPath: requested,
      }),
    );
  }

  // Realpath the FILE itself (not just its directory): a symlink named
  // like a script inside a contained directory must not escape.
  const resolved = yield* Effect.tryPromise({
    try: () => NodeFSP.realpath(requested),
    catch: (cause) =>
      new OrchestrationGetWorkflowScriptError({
        reason: "not-found",
        scriptPath: requested,
        cause,
      }),
  });

  const contained = roots.some(
    (root) => resolved === root || resolved.startsWith(`${root}${NodePath.sep}`),
  );
  if (!contained) {
    return yield* Effect.fail(
      new OrchestrationGetWorkflowScriptError({ reason: "outside-root", scriptPath: resolved }),
    );
  }
  if (NodePath.extname(resolved) !== ".js") {
    return yield* Effect.fail(
      new OrchestrationGetWorkflowScriptError({ reason: "not-js", scriptPath: resolved }),
    );
  }

  // TOCTOU-safe read (review finding): open FIRST, then verify what was
  // actually opened via the file descriptor. Re-checking the path after
  // open would race against a swap; fstat on the handle cannot. The two
  // containment checks fail with their own tagged reasons (not manufactured
  // Errors folded into read-failed); "read-failed" is reserved for genuine
  // platform failures with the real cause attached.
  const read = yield* Effect.tryPromise({
    try: async () => {
      const handle = await NodeFSP.open(resolved, "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) {
          return { failure: "not-regular-file" as const };
        }
        // The opened inode must be the same one realpath resolved to: a
        // process swapping the path between realpath and open changes the
        // inode, which this comparison catches.
        const pathStat = await NodeFSP.lstat(resolved);
        if (stat.ino !== pathStat.ino || stat.dev !== pathStat.dev) {
          return { failure: "changed-during-read" as const };
        }
        const truncated = stat.size > SCRIPT_BYTE_CAP;
        const buffer = Buffer.alloc(Math.min(stat.size, SCRIPT_BYTE_CAP));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return {
          contents: buffer.subarray(0, bytesRead).toString("utf8"),
          truncated,
        };
      } finally {
        await handle.close();
      }
    },
    catch: (cause) =>
      new OrchestrationGetWorkflowScriptError({
        reason: "read-failed",
        scriptPath: resolved,
        cause,
      }),
  });
  if ("failure" in read) {
    return yield* new OrchestrationGetWorkflowScriptError({
      reason: read.failure,
      scriptPath: resolved,
    });
  }

  return {
    scriptPath: resolved,
    contents: read.contents,
    truncated: read.truncated,
  };
});
