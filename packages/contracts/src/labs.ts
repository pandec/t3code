import * as Schema from "effect/Schema";

import { PositiveInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Fork: SP Labs. T3 drives the `sp-labs` CLI (`docs/t3.md` in the sp-labs repo) and mirrors its
 * JSON shapes here. Labs are persistent git worktrees of the labs project; Main/Staging and
 * Preview are shared environments shown beside them.
 *
 * A thread is a lab thread when its `worktreePath` equals a lab environment's `worktree`; no
 * other state links them. A lease's `threadId` is the T3 thread id that reserved it, compared
 * as-is (MCP-launched thread ids carry their `mcp:` prefix); an id that matches no thread is an
 * owner outside T3.
 */

// ── CLI shapes (`sp-labs status --runtime`) ─────────────────────────────

export const LabEnvironmentKind = Schema.Literals(["lab", "staging", "preview"]);
export type LabEnvironmentKind = typeof LabEnvironmentKind.Type;

/** A reservation. Mutations T3 runs for the user pass its `id` as `--lease`. */
export const LabLease = Schema.Struct({
  id: Schema.String,
  labId: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  purpose: Schema.String,
  acquiredAt: Schema.String,
});
export type LabLease = typeof LabLease.Type;

/** The human's standing claim on a lab; a bare `acquire` skips it. */
export const LabHold = Schema.Struct({
  labId: Schema.String,
  note: Schema.String,
  heldAt: Schema.String,
});
export type LabHold = typeof LabHold.Type;

/** The lab's standing note of surprising state, written at release. */
export const LabHandoff = Schema.Struct({
  summary: Schema.String,
  branch: Schema.String,
  commit: Schema.String,
  disposition: Schema.Literals(["usable", "needs-repair"]),
  threadId: Schema.NullOr(Schema.String),
  releasedAt: Schema.String,
});
export type LabHandoff = typeof LabHandoff.Type;

export const LabLinkState = Schema.Literals(["up", "down", "unknown"]);
export type LabLinkState = typeof LabLinkState.Type;

export const LabRuntimeOperation = Schema.Struct({
  id: Schema.String,
  command: Schema.String,
  startedAt: Schema.String,
  status: Schema.String,
});
export type LabRuntimeOperation = typeof LabRuntimeOperation.Type;

/** Passive health. `extension.state` is always "unverified": passive checks never verify. */
export const LabRuntime = Schema.Struct({
  checkedAt: Schema.String,
  chrome: Schema.Struct({ state: LabLinkState, detail: Schema.String }),
  wxt: Schema.Struct({ state: LabLinkState, detail: Schema.String }),
  backend: Schema.Struct({
    state: Schema.Literals(["ready", "unknown", "error"]),
    detail: Schema.String,
  }),
  extension: Schema.Struct({ state: Schema.String, detail: Schema.String }),
  /** `branch` is "Detached HEAD" when detached; null when git could not be read. */
  git: Schema.NullOr(
    Schema.Struct({ branch: Schema.String, commit: Schema.String, dirty: Schema.Boolean }),
  ),
  /** Whether the stack's tmux session exists; null when unknown or not applicable. */
  session: Schema.NullOr(Schema.Boolean),
  diagnosis: Schema.Array(Schema.String),
  /** A running exclusive sp-labs command (any caller, not only T3). */
  operation: Schema.NullOr(LabRuntimeOperation),
});
export type LabRuntime = typeof LabRuntime.Type;

export const LabEnvironment = Schema.Struct({
  /** "staging" | "sp-lab-N" | "preview". */
  id: Schema.String,
  name: Schema.String,
  kind: LabEnvironmentKind,
  /** "pending" | "ready" | "quarantined"; "unmanaged" for staging and preview. */
  phase: Schema.String,
  /** Ready, unreserved and not held; null for staging and preview. */
  available: Schema.NullOr(Schema.Boolean),
  worktree: Schema.String,
  cdpPort: Schema.Number,
  wxtPort: Schema.NullOr(Schema.Number),
  lease: Schema.NullOr(LabLease),
  hold: Schema.NullOr(LabHold),
  handoff: Schema.NullOr(LabHandoff),
  runtime: LabRuntime,
  /** Latest journaled command of the current reservation. */
  lastActivityAt: Schema.NullOr(Schema.String),
});
export type LabEnvironment = typeof LabEnvironment.Type;

/** The CLI's own definition: stopped only when no session and Chrome and WXT are down. */
export const isLabStackStopped = (runtime: LabRuntime): boolean =>
  runtime.session === false && runtime.chrome.state === "down" && runtime.wxt.state === "down";

export const LabHistoryItem = Schema.Struct({
  /** "op:<id>" | "lease:<id>" | "handoff:<leaseId>". */
  id: Schema.String,
  kind: Schema.Literals(["command", "reservation", "handoff"]),
  timestamp: Schema.String,
  command: Schema.NullOr(Schema.String),
  /** Command status; the disposition on handoff rows. */
  status: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
  purpose: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  commit: Schema.NullOr(Schema.String),
  detail: Schema.optional(Schema.Unknown),
});
export type LabHistoryItem = typeof LabHistoryItem.Type;

export const LabLogEntry = Schema.Struct({
  timestamp: Schema.String,
  stream: Schema.String,
  text: Schema.String,
  leaseId: Schema.optional(Schema.String),
  threadId: Schema.optional(Schema.String),
});
export type LabLogEntry = typeof LabLogEntry.Type;

// ── T3-side state ────────────────────────────────────────────────────────

/** What T3 is doing to an environment right now. Mutations on one environment run one at a time. */
export const LabT3Operation = Schema.Literals([
  "acquiring",
  "starting",
  "stopping",
  "reloading",
  "releasing",
  "opening-browser",
  "opening-sidepanel",
  "updating-hold",
]);
export type LabT3Operation = typeof LabT3Operation.Type;

/** The last `up` T3 ran on an environment. Success means exit 0 and `extension.ok`. */
export const LabUpResult = Schema.Struct({
  ok: Schema.Boolean,
  /** The failure reason; null on success. */
  detail: Schema.NullOr(Schema.String),
  at: Schema.String,
});
export type LabUpResult = typeof LabUpResult.Type;

export const LabT3State = Schema.Struct({
  operation: Schema.NullOr(LabT3Operation),
  lastUp: Schema.NullOr(LabUpResult),
});
export type LabT3State = typeof LabT3State.Type;

/** Lab worktree identity without runtime health: enough to recognize lab threads. */
export const LabInventoryEntry = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: LabEnvironmentKind,
  worktree: Schema.String,
  /** The current lease's thread; a thread that acquired the lab itself owns it from any worktree. */
  ownerThreadId: Schema.NullOr(Schema.String),
});
export type LabInventoryEntry = typeof LabInventoryEntry.Type;

const LabsResolvedConfig = {
  /** Whether an sp-labs directory resolved. False turns the feature off. */
  configured: Schema.Boolean,
  /** The resolved sp-labs checkout (the setting, or the default when it exists). */
  spLabsDirectory: Schema.NullOr(Schema.String),
  /** The resolved labs project (the setting, or the project rooted at `sourceCheckout`). */
  projectId: Schema.NullOr(ProjectId),
  /** The labs' source checkout (Main/Staging's worktree). */
  sourceCheckout: Schema.NullOr(Schema.String),
  /** The last CLI failure; previous data is kept. */
  error: Schema.NullOr(Schema.String),
};

/**
 * Cheap, non-polling view for marking lab threads (sidebar tint, header chip). Cached on the
 * server and refreshed by settings changes, mutations, and live polling.
 */
export const LabsInventory = Schema.Struct({
  ...LabsResolvedConfig,
  environments: Schema.Array(LabInventoryEntry),
});
export type LabsInventory = typeof LabsInventory.Type;

/** `labs.subscribe` payload: one on subscribe, then one per change. */
export const LabsSnapshot = Schema.Struct({
  ...LabsResolvedConfig,
  /** The CLI's `checkedAt` of the last successful status; null before the first. */
  checkedAt: Schema.NullOr(Schema.String),
  /** Ordered staging, sp-lab-1..N, preview. */
  environments: Schema.Array(LabEnvironment),
  /** Keyed by environment id; absent means idle with no `up` result yet. */
  t3: Schema.Record(Schema.String, LabT3State),
});
export type LabsSnapshot = typeof LabsSnapshot.Type;

// ── RPC inputs and results ───────────────────────────────────────────────

export const LabsSubscribeInput = Schema.Struct({});
export type LabsSubscribeInput = typeof LabsSubscribeInput.Type;

export const LabsInventoryInput = Schema.Struct({});
export type LabsInventoryInput = typeof LabsInventoryInput.Type;

/**
 * Reserves `labId` for `threadId` and checks out its branch; the client then launches the
 * thread with `workspaceStrategy: { type: "existing_worktree", worktreePath, branch }`.
 * Idempotent for a thread that already holds the lab, so a retried launch reuses it.
 */
export const LabsPrepareThreadInput = Schema.Struct({
  threadId: ThreadId,
  labId: TrimmedNonEmptyString,
  /**
   * With `baseRef`, a new branch created from it; without, an existing branch to continue.
   * Null asks for an automatic name (needs `baseRef`): a temporary `t3/<hex>` branch that the
   * launch renames from the first message, as New worktree does.
   */
  branch: Schema.NullOr(TrimmedNonEmptyString),
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  /** The reservation's purpose, shown in the Labs panel and history. */
  purpose: TrimmedNonEmptyString,
  /** Reserve a lab the human holds; only for the human's own explicit choice. */
  overrideHold: Schema.optional(Schema.Boolean),
});
export type LabsPrepareThreadInput = typeof LabsPrepareThreadInput.Type;

export const LabsPrepareThreadResult = Schema.Struct({
  labId: Schema.String,
  worktreePath: Schema.String,
  branch: Schema.String,
  leaseId: Schema.String,
});
export type LabsPrepareThreadResult = typeof LabsPrepareThreadResult.Type;

export const LabAction = Schema.Literals([
  "up",
  "down",
  "reload",
  "browser",
  "sidepanel",
  "hold",
  "unhold",
]);
export type LabAction = typeof LabAction.Type;

export const LabsActionInput = Schema.Struct({
  envId: TrimmedNonEmptyString,
  action: LabAction,
  /** The hold note; only read by `hold`. */
  note: Schema.optional(Schema.String),
});
export type LabsActionInput = typeof LabsActionInput.Type;

/** Resolves when the command finishes; the snapshot tracks it meanwhile. */
export const LabsActionResult = Schema.Struct({
  envId: Schema.String,
  action: LabAction,
  /** False only for an `up` whose extension check failed (the CLI exited 0). */
  ok: Schema.Boolean,
  detail: Schema.NullOr(Schema.String),
});
export type LabsActionResult = typeof LabsActionResult.Type;

export const LabsReleaseInput = Schema.Struct({
  labId: TrimmedNonEmptyString,
  /** Run `down` first when the stack is running, instead of reporting it as a blocker. */
  stopFirst: Schema.Boolean,
});
export type LabsReleaseInput = typeof LabsReleaseInput.Type;

export const LabReleaseBlocker = Schema.Struct({
  kind: Schema.Literals(["not_reserved", "dirty_worktree", "stack_running", "operation_running"]),
  detail: Schema.String,
});
export type LabReleaseBlocker = typeof LabReleaseBlocker.Type;

/** A release keeps the standing handoff note; it never writes one. */
export const LabsReleaseResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("released"),
    labId: Schema.String,
    handoff: Schema.NullOr(LabHandoff),
  }),
  Schema.Struct({
    status: Schema.Literal("blocked"),
    labId: Schema.String,
    blockers: Schema.Array(LabReleaseBlocker),
  }),
]);
export type LabsReleaseResult = typeof LabsReleaseResult.Type;

export const LabsHistoryInput = Schema.Struct({
  envId: TrimmedNonEmptyString,
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
  cursor: Schema.optional(TrimmedNonEmptyString),
});
export type LabsHistoryInput = typeof LabsHistoryInput.Type;

export const LabsHistoryResult = Schema.Struct({
  items: Schema.Array(LabHistoryItem),
  nextCursor: Schema.NullOr(Schema.String),
});
export type LabsHistoryResult = typeof LabsHistoryResult.Type;

export const LabsLogsInput = Schema.Struct({
  envId: TrimmedNonEmptyString,
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(1000))),
});
export type LabsLogsInput = typeof LabsLogsInput.Type;

/** Retained WXT/Convex output, oldest first. */
export const LabsLogsResult = Schema.Struct({
  entries: Schema.Array(LabLogEntry),
  /** A recorder is attached now. */
  captured: Schema.Boolean,
  files: Schema.Number,
  /** Why output may be missing (Preview, stopped runtime). */
  message: Schema.optional(Schema.String),
});
export type LabsLogsResult = typeof LabsLogsResult.Type;

export class LabsError extends Schema.TaggedError<LabsError>()("LabsError", {
  reason: Schema.Literals([
    /** No sp-labs directory resolved. */
    "not_configured",
    /** Unknown environment id, or not a lab where one is required. */
    "not_found",
    /** The CLI failed; `detail` is its own `error` text. */
    "cli_failed",
    /** The CLI's output did not match the contract. */
    "invalid_output",
    "timeout",
    /** The input is inconsistent (e.g. an automatic branch without a base). */
    "invalid_input",
  ]),
  detail: Schema.String,
}) {
  override get message(): string {
    switch (this.reason) {
      case "not_configured":
        return "SP Labs is not configured. Set the sp-labs directory in Settings → Extras → SP Labs.";
      default:
        return this.detail;
    }
  }
}
