import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type LabEnvironment,
  type LabLease,
  type LabsSnapshot,
  LabsError,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import ForkThreadHiddenNotesMigration from "../persistence/ForkMigrations/007_ForkThreadHiddenNotes.ts";
import ForkThreadHiddenNoteWorktreeMigration from "../persistence/ForkMigrations/008_ForkThreadHiddenNoteWorktree.ts";
import * as ThreadHiddenNotes from "../orchestration-v2/ThreadHiddenNotes.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as LabsCli from "./LabsCli.ts";
import * as LabsService from "./LabsService.ts";

const DIRECTORY = "/fake/sp-labs";
const SOURCE = "/fake/salespros";
const THREAD = ThreadId.make("thread-lab");
const LEASE: LabLease = {
  id: "lease-1",
  labId: "sp-lab-1",
  threadId: THREAD,
  purpose: "test",
  acquiredAt: "2026-10-14T00:00:00.000Z",
};

interface FakeLab {
  readonly lease: LabLease | null;
  readonly running: boolean;
  readonly dirty: boolean;
  readonly branch: string;
}

type UpBehaviour = { readonly type: "ok" } | { readonly type: "fail"; readonly error: string };

const environment = (id: string, lab: FakeLab | null): LabEnvironment => ({
  id,
  name: id === "staging" ? "Main / Staging" : id,
  kind: lab === null ? "staging" : "lab",
  phase: lab === null ? "unmanaged" : "ready",
  available: lab === null ? null : lab.lease === null,
  worktree: lab === null ? SOURCE : `/fake/${id}`,
  cdpPort: 9300,
  wxtPort: 3100,
  lease: lab?.lease ?? null,
  hold: null,
  handoff: null,
  runtime: {
    checkedAt: "2026-10-14T00:00:00.000Z",
    chrome: { state: lab?.running === true ? "up" : "down", detail: "" },
    wxt: { state: lab?.running === true ? "up" : "down", detail: "" },
    backend: { state: "unknown", detail: "" },
    extension: { state: "unverified", detail: "" },
    git: lab === null ? null : { branch: lab.branch, commit: "abc", dirty: lab.dirty },
    session: lab?.running === true,
    diagnosis: [],
    operation: null,
  },
  lastActivityAt: null,
});

/** A stand-in for the sp-labs CLI: records every call and keeps lab state across calls. */
const makeFakeCli = Effect.gen(function* () {
  const calls = yield* Queue.unbounded<LabsCli.LabsCliRunInput>();
  const labs = yield* Ref.make<Record<string, FakeLab>>({
    "sp-lab-1": { lease: null, running: false, dirty: false, branch: "Detached HEAD" },
  });
  const up = yield* Ref.make<UpBehaviour>({ type: "ok" });
  const statusFails = yield* Ref.make(false);
  /** A reservation someone else takes while `down` runs. */
  const leaseAfterDown = yield* Ref.make<LabLease | null | undefined>(undefined);
  const setLab = (id: string, update: (lab: FakeLab) => FakeLab) =>
    Ref.update(labs, (all) => ({ ...all, [id]: update(all[id]!) }));
  const run = (input: LabsCli.LabsCliRunInput): Effect.Effect<unknown, LabsError> =>
    Effect.gen(function* () {
      yield* Queue.offer(calls, input);
      const [command, target = ""] = input.args;
      switch (command) {
        case "status": {
          if (yield* Ref.get(statusFails)) {
            return yield* new LabsError({ reason: "cli_failed", detail: "status broke" });
          }
          const all = yield* Ref.get(labs);
          return {
            checkedAt: "2026-10-14T00:00:00.000Z",
            environments: [
              environment("staging", null),
              ...Object.entries(all).map(([id, lab]) => environment(id, lab)),
            ],
          };
        }
        case "acquire": {
          const branch = input.args[input.args.indexOf("--branch") + 1]!;
          const lease: LabLease = { ...LEASE, labId: target, threadId: input.threadId ?? null };
          yield* setLab(target, (lab) => ({ ...lab, lease, branch }));
          return { lease, worktree: `/fake/${target}`, handoff: null, branch };
        }
        case "up": {
          const behaviour = yield* Ref.get(up);
          if (behaviour.type === "fail") {
            return yield* new LabsError({ reason: "cli_failed", detail: behaviour.error });
          }
          yield* setLab(target, (lab) => ({ ...lab, running: true }));
          return { devReady: true, extension: { ok: true } };
        }
        case "down": {
          const next = yield* Ref.get(leaseAfterDown);
          yield* setLab(target, (lab) => ({
            ...lab,
            running: false,
            lease: next === undefined ? lab.lease : next,
          }));
          return [];
        }
        case "release":
          yield* setLab(target, (lab) => ({ ...lab, lease: null, branch: "Detached HEAD" }));
          return { released: target, phase: "ready", handoff: null };
        default:
          return yield* Effect.die(`unexpected sp-labs ${command}`);
      }
    });
  return {
    calls,
    up,
    statusFails,
    leaseAfterDown,
    setLab,
    layer: Layer.succeed(LabsCli.LabsCli, LabsCli.LabsCli.of({ run })),
  };
});
type FakeCli = Effect.Success<typeof makeFakeCli>;

const notesLayer = ThreadHiddenNotes.layer.pipe(
  Layer.provideMerge(
    Layer.effectDiscard(
      ForkThreadHiddenNotesMigration.pipe(Effect.andThen(ForkThreadHiddenNoteWorktreeMigration)),
    ),
  ),
  Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const withService = <A, E>(
  fake: FakeCli,
  effect: Effect.Effect<A, E, LabsService.LabsService | ThreadHiddenNotes.ThreadHiddenNotes>,
) =>
  effect.pipe(
    Effect.provide(
      LabsService.layer.pipe(
        Layer.provideMerge(notesLayer),
        Layer.provide(
          Layer.mergeAll(
            fake.layer,
            ServerSettings.layerTest({ labs: { spLabsDirectory: DIRECTORY } }),
            Layer.mock(ProjectService.ProjectService)({
              getByWorkspaceRoot: () => Effect.succeed(Option.none()),
            }),
            NodeServices.layer,
          ),
        ),
      ),
    ),
  );

/** Drains recorded calls up to and including the next `command`. */
const takeCall = (fake: FakeCli, command: string) =>
  Queue.take(fake.calls).pipe(Effect.repeat({ until: (call) => call.args[0] === command }));

const awaitSnapshot = (predicate: (snapshot: LabsSnapshot) => boolean) =>
  Effect.gen(function* () {
    const labs = yield* LabsService.LabsService;
    return yield* labs.subscribe.pipe(
      Stream.filter(predicate),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
  });

describe("LabsService", () => {
  it.effect("polls status only while someone subscribes, and pushes only changes", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeCli;
      yield* withService(
        fake,
        Effect.gen(function* () {
          const labs = yield* LabsService.LabsService;
          const snapshots = yield* Queue.unbounded<LabsSnapshot>();
          yield* TestClock.adjust("1 minute");
          assert.equal(yield* Queue.size(fake.calls), 0, "no polling without subscribers");

          const subscriber = yield* labs.subscribe.pipe(
            Stream.runForEach((snapshot) => Queue.offer(snapshots, snapshot)),
            Effect.forkChild,
          );
          assert.deepEqual((yield* Queue.take(fake.calls)).args, ["status", "--runtime"]);
          const first = yield* Queue.take(snapshots);
          assert.isTrue(first.configured);
          assert.equal(first.sourceCheckout, SOURCE);
          assert.deepEqual(
            first.environments.map((env) => env.id),
            ["staging", "sp-lab-1"],
          );

          // An unchanged poll pushes nothing; a change does.
          yield* TestClock.adjust(LabsService.LABS_POLL_INTERVAL);
          yield* takeCall(fake, "status");
          assert.equal(yield* Queue.size(snapshots), 0);
          yield* fake.setLab("sp-lab-1", (lab) => ({ ...lab, dirty: true }));
          yield* TestClock.adjust(LabsService.LABS_POLL_INTERVAL);
          yield* takeCall(fake, "status");
          const changed = yield* Queue.take(snapshots);
          assert.isTrue(changed.environments[1]!.runtime.git!.dirty);

          yield* Fiber.interrupt(subscriber);
          yield* TestClock.adjust("5 minutes");
          assert.equal(yield* Queue.size(fake.calls), 0, "polling stops with the last subscriber");
        }),
      );
    }),
  );

  it.effect("prepares a lab thread: acquire for the thread, first-turn note, then up", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeCli;
      yield* withService(
        fake,
        Effect.gen(function* () {
          const labs = yield* LabsService.LabsService;
          const notes = yield* ThreadHiddenNotes.ThreadHiddenNotes;
          const input = {
            threadId: THREAD,
            labId: "sp-lab-1",
            branch: null,
            baseRef: "master",
            purpose: "Fix the parser",
          };
          const prepared = yield* labs.prepareThread(input);
          assert.match(prepared.branch, /^t3\/[0-9a-f]{8}$/);
          assert.deepEqual(prepared, {
            labId: "sp-lab-1",
            worktreePath: "/fake/sp-lab-1",
            branch: prepared.branch,
            leaseId: "lease-1",
          });

          const acquire = yield* takeCall(fake, "acquire");
          assert.equal(acquire.threadId, THREAD);
          assert.deepEqual(acquire.args, [
            "acquire",
            "sp-lab-1",
            "--purpose",
            "Fix the parser",
            "--branch",
            prepared.branch,
            "--base",
            "master",
          ]);
          const labTurn = { worktreePath: "/fake/sp-lab-1" };
          const pending = yield* notes.pending(THREAD, labTurn);
          assert.equal(pending.length, 1);
          assert.include(pending[0]!.text, "This thread runs in sp-lab-1");
          assert.include(pending[0]!.text, prepared.branch);

          // `up` runs in the background, for the thread's lease.
          const up = yield* takeCall(fake, "up");
          assert.deepEqual(up.args, ["up", "sp-lab-1", "--lease", "lease-1"]);
          const settled = yield* awaitSnapshot(
            (snapshot) =>
              snapshot.t3["sp-lab-1"]?.lastUp != null &&
              snapshot.t3["sp-lab-1"]?.operation === null,
          );
          assert.isTrue(settled.t3["sp-lab-1"]!.lastUp!.ok);
          // Success tells the agent nothing more.
          assert.equal((yield* notes.pending(THREAD, labTurn)).length, 1);
          // The first turn hears it; a retry must not queue it again.
          yield* notes.acknowledge(pending.map((note) => note.id));

          // A retried launch reuses the reservation instead of acquiring again.
          yield* Queue.clear(fake.calls);
          const retried = yield* labs.prepareThread(input);
          assert.equal(retried.leaseId, "lease-1");
          assert.equal(retried.branch, prepared.branch);
          const later = yield* Queue.clear(fake.calls);
          assert.isFalse(later.some((call) => call.args[0] === "acquire" || call.args[0] === "up"));
          assert.deepEqual(yield* notes.pending(THREAD, labTurn), []);

          // Never act on cached state: a failed status read fails the mutation.
          yield* Ref.set(fake.statusFails, true);
          const failed = yield* labs
            .prepareThread(input)
            .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => null }));
          assert.equal(failed?.reason, "cli_failed");
        }),
      );
    }),
  );

  it.effect(
    "queues a one-line note for the owning thread when up fails, and drops it on success",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakeCli;
        yield* fake.setLab("sp-lab-1", (lab) => ({ ...lab, lease: LEASE }));
        yield* Ref.set(fake.up, { type: "fail", error: "Convex did not become ready" });
        yield* withService(
          fake,
          Effect.gen(function* () {
            const labs = yield* LabsService.LabsService;
            const notes = yield* ThreadHiddenNotes.ThreadHiddenNotes;
            const failed = yield* labs.action({ envId: "sp-lab-1", action: "up" });
            assert.deepEqual(failed, {
              envId: "sp-lab-1",
              action: "up",
              ok: false,
              detail: "Convex did not become ready",
            });
            assert.deepEqual(
              (yield* notes.pending(THREAD, null)).map((note) => note.text),
              ["`sp-labs up sp-lab-1` failed: Convex did not become ready"],
            );

            yield* Ref.set(fake.up, { type: "ok" });
            assert.isTrue((yield* labs.action({ envId: "sp-lab-1", action: "up" })).ok);
            assert.deepEqual(yield* notes.pending(THREAD, null), []);
          }),
        );
      }),
  );

  it.effect("reports release blockers, and stops a running stack first when asked", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeCli;
      yield* fake.setLab("sp-lab-1", (lab) => ({
        ...lab,
        running: true,
        dirty: true,
        lease: LEASE,
      }));
      yield* withService(
        fake,
        Effect.gen(function* () {
          const labs = yield* LabsService.LabsService;
          const blocked = yield* labs.release({ labId: "sp-lab-1", stopFirst: false });
          assert.deepEqual(
            blocked.status === "blocked" ? blocked.blockers.map((blocker) => blocker.kind) : [],
            ["dirty_worktree", "stack_running"],
          );

          yield* fake.setLab("sp-lab-1", (lab) => ({ ...lab, dirty: false }));
          yield* Queue.clear(fake.calls);
          const released = yield* labs.release({ labId: "sp-lab-1", stopFirst: true });
          assert.deepEqual(released, { status: "released", labId: "sp-lab-1", handoff: null });
          const commands = (yield* Queue.clear(fake.calls))
            .map((call) => call.args)
            .filter((args) => args[0] !== "status");
          assert.deepEqual(commands, [
            ["down", "sp-lab-1", "--lease", "lease-1"],
            ["release", "sp-lab-1", "--lease", "lease-1"],
          ]);

          // A reservation taken while the stack stops is never released.
          yield* fake.setLab("sp-lab-1", (lab) => ({ ...lab, running: true, lease: LEASE }));
          yield* Ref.set(fake.leaseAfterDown, { ...LEASE, id: "lease-2", threadId: "other" });
          yield* Queue.clear(fake.calls);
          const raced = yield* labs.release({ labId: "sp-lab-1", stopFirst: true });
          assert.deepEqual(
            raced.status === "blocked" ? raced.blockers.map((blocker) => blocker.kind) : [],
            ["not_reserved"],
          );
          assert.isFalse(
            (yield* Queue.clear(fake.calls)).some((call) => call.args[0] === "release"),
          );
        }),
      );
    }),
  );
});
