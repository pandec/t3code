/**
 * Fork: SP Labs. Mirrors `sp-labs status --runtime`, polling only while subscribed (mutations
 * refresh once). `KeyedLock` serializes mutations per environment. A lab thread's first turn gets
 * a hidden note about its lab; a failed `up` queues one for the owning thread's next turn.
 */
import * as NodeOS from "node:os";

import {
  type LabEnvironment,
  type LabReleaseBlocker,
  type LabsActionInput,
  type LabsActionResult,
  type LabsHistoryInput,
  type LabsInventory,
  type LabsLogsInput,
  type LabsPrepareThreadInput,
  type LabsPrepareThreadResult,
  type LabsReleaseInput,
  type LabsReleaseResult,
  type LabsSnapshot,
  type LabT3Operation,
  type LabT3State,
  type ProjectId,
  isLabStackStopped,
  LabEnvironment as LabEnvironmentSchema,
  LabHandoff,
  LabLease,
  LabsError,
  LabsHistoryResult,
  LabsLogsResult,
  ThreadId,
} from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as ThreadHiddenNotes from "../orchestration-v2/ThreadHiddenNotes.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as LabsCli from "./LabsCli.ts";

/** Live polling cadence while at least one client subscribes. */
export const LABS_POLL_INTERVAL = Duration.seconds(15);
/** Where BD's sp-labs checkout lives; used when the setting is unset and it exists. */
const DEFAULT_SP_LABS_RELATIVE_DIRECTORY = "SynologyDrive/AIMac/repos/sp-labs";

/** Hidden note kinds (see ThreadHiddenNotes). */
const labNoteKind = (leaseId: string) => `sp-labs:lab:${leaseId}`;
const UP_FAILED_NOTE_KIND = "sp-labs:up-failed";

const TIMEOUTS = {
  status: Duration.seconds(30),
  acquire: Duration.minutes(2),
  // `up` (and `restart-wxt`) may install dependencies, then waits up to 60 s for readiness.
  up: Duration.minutes(6),
  down: Duration.minutes(2),
  reload: Duration.minutes(2),
  release: Duration.minutes(1),
  quick: Duration.seconds(60),
} as const;

const StatusOutput = Schema.Struct({
  checkedAt: Schema.String,
  environments: Schema.Array(LabEnvironmentSchema),
});
/** `handoff` and `personaPlans` are optional: older sp-labs checkouts do not print them. */
const AcquireOutput = Schema.Struct({
  lease: LabLease,
  worktree: Schema.String,
  handoff: Schema.optional(Schema.NullOr(LabHandoff)),
  personaPlans: Schema.optional(
    Schema.NullOr(Schema.Struct({ warnings: Schema.Array(Schema.String) })),
  ),
});
const UpOutput = Schema.Struct({
  extension: Schema.Struct({ ok: Schema.Boolean, reason: Schema.optional(Schema.String) }),
});
const ReleaseOutput = Schema.Struct({ handoff: Schema.NullOr(LabHandoff) });

export class LabsService extends Context.Service<
  LabsService,
  {
    /** The current snapshot, then one per change. */
    readonly subscribe: Stream.Stream<LabsSnapshot>;
    readonly getInventory: Effect.Effect<LabsInventory>;
    readonly prepareThread: (
      input: LabsPrepareThreadInput,
    ) => Effect.Effect<LabsPrepareThreadResult, LabsError>;
    readonly action: (input: LabsActionInput) => Effect.Effect<LabsActionResult, LabsError>;
    readonly release: (input: LabsReleaseInput) => Effect.Effect<LabsReleaseResult, LabsError>;
    readonly history: (input: LabsHistoryInput) => Effect.Effect<LabsHistoryResult, LabsError>;
    readonly logs: (input: LabsLogsInput) => Effect.Effect<LabsLogsResult, LabsError>;
  }
>()("t3/labs/LabsService") {}

interface CoreState {
  readonly directory: string | null;
  readonly projectId: ProjectId | null;
  readonly sourceCheckout: string | null;
  readonly checkedAt: string | null;
  readonly environments: ReadonlyArray<LabEnvironment>;
  readonly error: string | null;
  /** A status read (or the not-configured resolution) completed for `directory`. */
  readonly loaded: boolean;
}

const INITIAL_CORE: CoreState = {
  directory: null,
  projectId: null,
  sourceCheckout: null,
  checkedAt: null,
  environments: [],
  error: null,
  loaded: false,
};

/** How old the inventory's status may be before `getInventory` re-reads it. */
const INVENTORY_MAX_AGE_MS = 30_000;

const IDLE_T3_STATE: LabT3State = { operation: null, lastUp: null };

/** The first-turn note of a thread started in a lab. */
const labThreadNote = (input: {
  readonly labId: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly autoBranch: boolean;
  readonly handoff: LabHandoff | null;
  readonly personaPlanWarnings: ReadonlyArray<string>;
}): string =>
  [
    [
      `This thread runs in ${input.labId} (worktree ${input.worktreePath}, branch ${input.branch}${input.autoBranch ? ", which T3 renames to match the task" : ""}), reserved for this thread by T3 Code.`,
      "Do not run `sp-labs acquire`.",
      "The lab's dev stack is starting and will be available shortly; you will be told if it fails.",
      `When done: commit, then \`sp-labs down ${input.labId}\` and \`sp-labs release ${input.labId}\` (pass --handoff only for surprising state).`,
      "Run `sp-labs status` for the lab's handoff note and persona-plan warnings.",
    ].join(" "),
    ...(input.handoff === null || input.handoff.summary.trim() === ""
      ? []
      : [
          `The lab's standing handoff note${input.handoff.disposition === "needs-repair" ? " (needs repair)" : ""}: ${input.handoff.summary.trim()}`,
        ]),
    ...input.personaPlanWarnings,
  ].join("\n");

/** The one-liner a lab thread's next turn carries after a failed `up` or `restart-wxt`. */
const labUpFailedNote = (command: string, labId: string, detail: string): string =>
  `\`sp-labs ${command} ${labId}\` failed: ${detail}`;

/** What stops a release. A running stack only blocks when the caller did not ask to stop it. */
const labReleaseBlockers = (
  environment: LabEnvironment,
  stopFirst: boolean,
): ReadonlyArray<LabReleaseBlocker> => [
  ...(environment.lease === null
    ? [{ kind: "not_reserved" as const, detail: `${environment.name} is not reserved.` }]
    : []),
  ...(environment.runtime.git?.dirty === true
    ? [
        {
          kind: "dirty_worktree" as const,
          detail: "The worktree has uncommitted changes; commit or preserve them first.",
        },
      ]
    : []),
  ...(environment.runtime.operation === null
    ? []
    : [
        {
          kind: "operation_running" as const,
          detail: `sp-labs ${environment.runtime.operation.command} is still running.`,
        },
      ]),
  ...(!stopFirst && !isLabStackStopped(environment.runtime)
    ? [{ kind: "stack_running" as const, detail: "The dev stack is running." }]
    : []),
];

const decodeOutput = <S extends Schema.Top>(schema: S, command: string) => {
  const decode = Schema.decodeUnknownEffect(schema);
  return (output: unknown) =>
    decode(output).pipe(
      Effect.mapError(
        () =>
          new LabsError({
            reason: "invalid_output",
            detail: `sp-labs ${command} printed output T3 does not understand; update T3 or sp-labs.`,
          }),
      ),
    ) as Effect.Effect<S["Type"], LabsError, S["DecodingServices"]>;
};

const make = Effect.gen(function* () {
  const cli = yield* LabsCli.LabsCli;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const hiddenNotes = yield* ThreadHiddenNotes.ThreadHiddenNotes;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const scope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));

  const defaultDirectory = path.join(NodeOS.homedir(), DEFAULT_SP_LABS_RELATIVE_DIRECTORY);
  const core = yield* Ref.make<CoreState>(INITIAL_CORE);
  const t3State = yield* Ref.make<Readonly<Record<string, LabT3State>>>({});
  /** When `getInventory` last re-read status, so a failing CLI is not re-run on every call. */
  const inventoryAttemptAt = yield* Ref.make(0);
  const snapshots = yield* SubscriptionRef.make<LabsSnapshot | null>(null);
  const refreshLock = yield* Semaphore.make(1);
  const environmentLocks = yield* KeyedLock.make<string>();
  const poller = yield* SynchronizedRef.make<{
    readonly subscribers: number;
    readonly fiber: Fiber.Fiber<void> | null;
  }>({ subscribers: 0, fiber: null });

  const publish = Effect.gen(function* () {
    const state = yield* Ref.get(core);
    const t3 = yield* Ref.get(t3State);
    const next: LabsSnapshot = {
      configured: state.directory !== null,
      spLabsDirectory: state.directory,
      projectId: state.projectId,
      sourceCheckout: state.sourceCheckout,
      error: state.error,
      checkedAt: state.checkedAt,
      environments: state.environments,
      t3,
    };
    const current = yield* SubscriptionRef.get(snapshots);
    // Polls mostly see nothing new; subscribers only hear about changes.
    if (current === null || !Equal.equals(current, next)) {
      yield* SubscriptionRef.set(snapshots, next);
    }
  });

  const updateT3 = (envId: string, update: (state: LabT3State) => LabT3State) =>
    Ref.update(t3State, (all) => {
      const next = update(all[envId] ?? IDLE_T3_STATE);
      const { [envId]: _previous, ...rest } = all;
      return next.operation === null && next.lastUp === null ? rest : { ...rest, [envId]: next };
    }).pipe(Effect.andThen(publish));
  const setOperation = (envId: string, operation: LabT3Operation | null) =>
    updateT3(envId, (state) => ({ ...state, operation }));

  /** The configured sp-labs checkout, or null when the feature is off. */
  const resolveSettings = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.map((value) => value.labs),
      Effect.orElseSucceed(() => ({ spLabsDirectory: null, projectId: null })),
    );
    const directory =
      settings.spLabsDirectory === null
        ? (yield* fileSystem
            .exists(path.join(defaultDirectory, "src", "cli.ts"))
            .pipe(Effect.orElseSucceed(() => false)))
          ? defaultDirectory
          : null
        : settings.spLabsDirectory === ""
          ? null
          : settings.spLabsDirectory;
    return { directory, projectId: settings.projectId };
  });

  /** Reads `status --runtime` into the snapshot. Failures land in `error`; never fails. */
  const refresh = refreshLock.withPermits(1)(
    Effect.gen(function* () {
      const settings = yield* resolveSettings;
      const previous = yield* Ref.get(core);
      const base: CoreState =
        previous.directory === settings.directory
          ? previous
          : { ...INITIAL_CORE, directory: settings.directory };
      if (settings.directory === null) {
        yield* Ref.set(core, { ...base, projectId: settings.projectId, loaded: true });
        return yield* publish;
      }
      const status = yield* cli
        .run({
          directory: settings.directory,
          args: ["status", "--runtime"],
          timeout: TIMEOUTS.status,
        })
        .pipe(Effect.flatMap(decodeOutput(StatusOutput, "status")), Effect.exit);
      if (Exit.isFailure(status)) {
        const error = Exit.findErrorOption(status);
        yield* Ref.set(core, {
          ...base,
          projectId: settings.projectId ?? base.projectId,
          error: Option.isSome(error) ? error.value.message : "sp-labs status failed.",
          loaded: true,
        });
        return yield* publish;
      }
      const sourceCheckout =
        status.value.environments.find((environment) => environment.kind === "staging")?.worktree ??
        null;
      const projectId =
        settings.projectId ??
        (sourceCheckout === null
          ? null
          : yield* projects.getByWorkspaceRoot(sourceCheckout).pipe(
              Effect.map(Option.match({ onNone: () => null, onSome: (project) => project.id })),
              Effect.orElseSucceed(() => base.projectId),
            ));
      yield* Ref.set(core, {
        directory: settings.directory,
        projectId,
        sourceCheckout,
        checkedAt: status.value.checkedAt,
        environments: status.value.environments,
        error: null,
        loaded: true,
      });
      yield* publish;
    }),
  );

  const ensureLoaded = Effect.gen(function* () {
    if (!(yield* Ref.get(core)).loaded) yield* refresh;
    return yield* Ref.get(core);
  });

  const requireDirectory = Effect.gen(function* () {
    const { directory } = yield* resolveSettings;
    if (directory === null) {
      return yield* new LabsError({ reason: "not_configured", detail: "" });
    }
    return directory;
  });

  /** The lab as the CLI reports it now; mutations act on current leases, not the last poll. */
  const findLab = Effect.fn("LabsService.findLab")(function* (envId: string) {
    const directory = yield* requireDirectory;
    yield* refresh;
    const state = yield* Ref.get(core);
    // Never act on the cached status: ownership may have changed since.
    if (state.error !== null) {
      return yield* new LabsError({ reason: "cli_failed", detail: state.error });
    }
    const environment = state.environments.find((candidate) => candidate.id === envId);
    if (environment === undefined) {
      return yield* new LabsError({
        reason: "not_found",
        detail: `No SP Labs environment named ${envId}.`,
      });
    }
    if (environment.kind !== "lab") {
      return yield* new LabsError({
        reason: "not_found",
        detail: `${environment.name} is not a lab.`,
      });
    }
    return { directory, environment };
  });

  /** Runs one mutation on `envId`: marks the operation, then refreshes before clearing it. */
  const mutate = <A>(
    envId: string,
    operation: LabT3Operation,
    effect: Effect.Effect<A, LabsError>,
  ): Effect.Effect<A, LabsError> =>
    environmentLocks.withLock(
      envId,
      setOperation(envId, operation).pipe(
        Effect.andThen(effect),
        Effect.ensuring(refresh.pipe(Effect.andThen(setOperation(envId, null)))),
      ),
    );

  const leaseArgs = (environment: LabEnvironment) =>
    environment.lease === null ? [] : ["--lease", environment.lease.id];

  /** `up` and `restart-wxt` share their output, success rule, and failure note. */
  const runUp = (
    labId: string,
    action: "up" | "restart-wxt",
  ): Effect.Effect<LabsActionResult, LabsError> =>
    mutate(
      labId,
      action === "up" ? "starting" : "restarting-wxt",
      Effect.gen(function* () {
        const { directory, environment } = yield* findLab(labId);
        const outcome = yield* cli
          .run({
            directory,
            args: [action, labId, ...leaseArgs(environment)],
            timeout: TIMEOUTS.up,
          })
          .pipe(Effect.flatMap(decodeOutput(UpOutput, action)), Effect.exit);
        const failure = Exit.isFailure(outcome)
          ? Option.match(Exit.findErrorOption(outcome), {
              onNone: () => `sp-labs ${action} stopped unexpectedly.`,
              onSome: (error) => error.message,
            })
          : outcome.value.extension.ok
            ? null
            : (outcome.value.extension.reason ??
              "The lab extension did not pass its identity check.");
        const at = DateTime.formatIso(yield* DateTime.now);
        yield* updateT3(labId, (state) => ({
          ...state,
          lastUp: { ok: failure === null, detail: failure, at },
        }));
        const owner = environment.lease?.threadId ?? null;
        if (owner !== null) {
          const threadId = ThreadId.make(owner);
          yield* (
            failure === null
              ? hiddenNotes.remove({ threadId, kind: UP_FAILED_NOTE_KIND })
              : hiddenNotes.put({
                  threadId,
                  kind: UP_FAILED_NOTE_KIND,
                  text: labUpFailedNote(action, labId, failure),
                })
          ).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Failed to update the lab thread's hidden note", { labId, cause }),
            ),
          );
        }
        return { envId: labId, action, ok: failure === null, detail: failure };
      }),
    );

  const runSimple = (
    envId: string,
    action: Exclude<LabsActionInput["action"], "up" | "restart-wxt">,
    note: string | undefined,
  ): Effect.Effect<LabsActionResult, LabsError> => {
    const plan = {
      down: { operation: "stopping", timeout: TIMEOUTS.down, scoped: true },
      reload: { operation: "reloading", timeout: TIMEOUTS.reload, scoped: true },
      browser: { operation: "opening-browser", timeout: TIMEOUTS.quick, scoped: true },
      sidepanel: { operation: "opening-sidepanel", timeout: TIMEOUTS.quick, scoped: true },
      hold: { operation: "updating-hold", timeout: TIMEOUTS.quick, scoped: false },
      unhold: { operation: "updating-hold", timeout: TIMEOUTS.quick, scoped: false },
    } as const satisfies Record<
      typeof action,
      { operation: LabT3Operation; timeout: Duration.Duration; scoped: boolean }
    >;
    const step = plan[action];
    return mutate(
      envId,
      step.operation,
      Effect.gen(function* () {
        const { directory, environment } = yield* findLab(envId);
        yield* cli.run({
          directory,
          args: [
            action,
            envId,
            ...(step.scoped ? leaseArgs(environment) : []),
            ...(action === "hold" ? ["--note", note ?? ""] : []),
          ],
          timeout: step.timeout,
        });
        return { envId, action, ok: true, detail: null };
      }),
    );
  };

  const action: LabsService["Service"]["action"] = (input) =>
    input.action === "up" || input.action === "restart-wxt"
      ? runUp(input.envId, input.action)
      : runSimple(input.envId, input.action, input.note);

  const prepareThread: LabsService["Service"]["prepareThread"] = Effect.fn(
    "LabsService.prepareThread",
  )(function* (input) {
    if (input.branch === null && input.baseRef === null) {
      return yield* new LabsError({
        reason: "invalid_input",
        detail: "An automatic branch name needs a base to create it from.",
      });
    }
    const prepared = yield* mutate(
      input.labId,
      "acquiring",
      Effect.gen(function* () {
        const { directory, environment } = yield* findLab(input.labId);
        // A retried launch finds the lab already reserved for this thread.
        if (environment.lease !== null && environment.lease.threadId === input.threadId) {
          return {
            labId: input.labId,
            worktreePath: environment.worktree,
            branch: environment.runtime.git?.branch ?? input.branch ?? "",
            leaseId: environment.lease.id,
            autoBranch: false,
            stackStopped: isLabStackStopped(environment.runtime),
            handoff: environment.handoff,
            // `status --runtime` does not carry the plan check; the note points at `sp-labs status`.
            personaPlanWarnings: [],
          };
        }
        // The launch renames a temporary branch from the first message, in the lab worktree.
        const token = (yield* randomUuidV4).replaceAll("-", "");
        const branch = input.branch ?? buildTemporaryWorktreeBranchName(() => token);
        const acquired = yield* cli
          .run({
            directory,
            args: [
              "acquire",
              input.labId,
              "--purpose",
              input.purpose,
              "--branch",
              branch,
              ...(input.baseRef === null ? [] : ["--base", input.baseRef]),
              ...(input.overrideHold === true ? ["--override-hold"] : []),
            ],
            threadId: input.threadId,
            timeout: TIMEOUTS.acquire,
          })
          .pipe(Effect.flatMap(decodeOutput(AcquireOutput, "acquire")));
        return {
          labId: input.labId,
          worktreePath: acquired.worktree,
          branch,
          leaseId: acquired.lease.id,
          autoBranch: input.branch === null,
          stackStopped: true,
          handoff: acquired.handoff ?? null,
          personaPlanWarnings: acquired.personaPlans?.warnings ?? [],
        };
      }),
    );
    // Every call for the holding thread ensures the note, once per lease: a retry restores one
    // a failed write lost, and never repeats one already delivered. Bound to the lab worktree,
    // so a thread launched elsewhere after all never hears it.
    yield* hiddenNotes
      .put({
        threadId: input.threadId,
        kind: labNoteKind(prepared.leaseId),
        text: labThreadNote(prepared),
        worktreePath: prepared.worktreePath,
        once: true,
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to queue the lab thread's first-turn note", {
            labId: input.labId,
            cause,
          }),
        ),
      );
    // The agent starts right away; `up` runs beside it and reports through the snapshot.
    const operation = (yield* Ref.get(t3State))[input.labId]?.operation ?? null;
    if (prepared.stackStopped && operation !== "starting") {
      yield* runUp(input.labId, "up").pipe(Effect.ignore, Effect.forkIn(scope));
    }
    return {
      labId: prepared.labId,
      worktreePath: prepared.worktreePath,
      branch: prepared.branch,
      leaseId: prepared.leaseId,
    };
  });

  const release: LabsService["Service"]["release"] = (input) =>
    mutate(
      input.labId,
      "releasing",
      Effect.gen(function* () {
        const { directory, environment } = yield* findLab(input.labId);
        const blockers = labReleaseBlockers(environment, input.stopFirst);
        // Every step acts on this reservation (a missing one is a blocker), never a later one.
        const lease = environment.lease;
        if (blockers.length > 0 || lease === null) {
          return { status: "blocked" as const, labId: input.labId, blockers };
        }
        let current = environment;
        if (!isLabStackStopped(current.runtime)) {
          yield* setOperation(input.labId, "stopping");
          yield* cli.run({
            directory,
            args: ["down", input.labId, "--lease", lease.id],
            timeout: TIMEOUTS.down,
          });
          current = (yield* findLab(input.labId)).environment;
          if (current.lease?.id !== lease.id) {
            return {
              status: "blocked" as const,
              labId: input.labId,
              blockers: [
                {
                  kind: "not_reserved" as const,
                  detail: "The reservation changed while the stack stopped; nothing was released.",
                },
              ],
            };
          }
          if (!isLabStackStopped(current.runtime)) {
            return {
              status: "blocked" as const,
              labId: input.labId,
              blockers: [
                {
                  kind: "stack_running" as const,
                  detail: "The dev stack is still running after down.",
                },
              ],
            };
          }
          yield* setOperation(input.labId, "releasing");
        }
        // No --handoff: the lab's standing note stays as it is.
        const released = yield* cli
          .run({
            directory,
            args: ["release", input.labId, "--lease", lease.id],
            timeout: TIMEOUTS.release,
          })
          .pipe(Effect.flatMap(decodeOutput(ReleaseOutput, "release")));
        const owner = lease.threadId;
        if (owner !== null) {
          const threadId = ThreadId.make(owner);
          yield* Effect.forEach([labNoteKind(lease.id), UP_FAILED_NOTE_KIND], (kind) =>
            hiddenNotes.remove({ threadId, kind }),
          ).pipe(Effect.ignore);
        }
        return { status: "released" as const, labId: input.labId, handoff: released.handoff };
      }),
    );

  const history: LabsService["Service"]["history"] = Effect.fn("LabsService.history")(
    function* (input) {
      const directory = yield* requireDirectory;
      return yield* cli
        .run({
          directory,
          args: [
            "history",
            input.envId,
            ...(input.limit === undefined ? [] : ["--limit", String(input.limit)]),
            ...(input.cursor === undefined ? [] : ["--cursor", input.cursor]),
          ],
          timeout: TIMEOUTS.status,
        })
        .pipe(Effect.flatMap(decodeOutput(LabsHistoryResult, "history")));
    },
  );

  const logs: LabsService["Service"]["logs"] = Effect.fn("LabsService.logs")(function* (input) {
    const directory = yield* requireDirectory;
    return yield* cli
      .run({
        directory,
        args: [
          "env-logs",
          input.envId,
          ...(input.limit === undefined ? [] : ["--limit", String(input.limit)]),
        ],
        timeout: TIMEOUTS.status,
      })
      .pipe(Effect.flatMap(decodeOutput(LabsLogsResult, "env-logs")));
  });

  const getInventory: LabsService["Service"]["getInventory"] = Effect.gen(function* () {
    // Agents acquire and release labs through the CLI too; re-read a status older than this.
    const loaded = yield* ensureLoaded;
    const now = yield* Clock.currentTimeMillis;
    const checkedAt = loaded.checkedAt === null ? 0 : Date.parse(loaded.checkedAt);
    const age = now - Math.max(checkedAt, yield* Ref.get(inventoryAttemptAt));
    const state =
      age > INVENTORY_MAX_AGE_MS
        ? yield* Ref.set(inventoryAttemptAt, now).pipe(
            Effect.andThen(refresh),
            Effect.andThen(Ref.get(core)),
          )
        : loaded;
    return {
      configured: state.directory !== null,
      spLabsDirectory: state.directory,
      projectId: state.projectId,
      sourceCheckout: state.sourceCheckout,
      error: state.error,
      environments: state.environments.map(({ id, name, kind, worktree, lease }) => ({
        id,
        name,
        kind,
        worktree,
        ownerThreadId: lease?.threadId ?? null,
      })),
    };
  });

  const retainPoller = SynchronizedRef.updateEffect(poller, (state) =>
    state.fiber !== null
      ? Effect.succeed({ ...state, subscribers: state.subscribers + 1 })
      : refresh.pipe(
          Effect.andThen(Effect.sleep(LABS_POLL_INTERVAL)),
          Effect.forever,
          Effect.forkIn(scope),
          Effect.map((fiber) => ({ subscribers: state.subscribers + 1, fiber })),
        ),
  );
  const releasePoller = SynchronizedRef.modify(poller, (state) =>
    state.subscribers > 1
      ? [null, { ...state, subscribers: state.subscribers - 1 }]
      : [state.fiber, { subscribers: 0, fiber: null }],
  ).pipe(Effect.flatMap((fiber) => (fiber === null ? Effect.void : Fiber.interrupt(fiber))));

  const subscribe: LabsService["Service"]["subscribe"] = Stream.unwrap(
    retainPoller.pipe(
      Effect.as(
        SubscriptionRef.changes(snapshots).pipe(
          Stream.filter((snapshot): snapshot is LabsSnapshot => snapshot !== null),
          Stream.ensuring(releasePoller),
        ),
      ),
    ),
  );

  // A changed sp-labs directory or labs project re-resolves the inventory.
  yield* serverSettings.streamChanges.pipe(
    Stream.map((settings) => settings.labs),
    Stream.changesWith(
      (left, right) =>
        left.spLabsDirectory === right.spLabsDirectory && left.projectId === right.projectId,
    ),
    Stream.runForEach(() => refresh),
    Effect.forkIn(scope),
  );

  return LabsService.of({
    subscribe,
    getInventory,
    prepareThread,
    action,
    release,
    history,
    logs,
  });
});

export const layer = Layer.effect(LabsService, make);
