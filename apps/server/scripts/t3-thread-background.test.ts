import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeChildProcess from "node:child_process";
import { assert, describe, it } from "@effect/vitest";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../src/persistence/NodeSqliteClient.ts";
import {
  collectLiveTasks,
  foldLiveness,
  probeSession,
  runThreadBackground,
} from "./t3-thread-background.ts";

const THREAD = "thread-1";

interface RowInput {
  readonly kind: string;
  readonly at: string;
  readonly payload: Record<string, unknown>;
  readonly threadId?: string;
}

function rows(...inputs: ReadonlyArray<RowInput>) {
  return inputs.map((input) => ({
    thread_id: input.threadId ?? THREAD,
    kind: input.kind,
    created_at: input.at,
    payload_json: JSON.stringify(input.payload),
  }));
}

const started = (payload: Record<string, unknown>, at = "2026-08-13T12:00:00.000Z"): RowInput => ({
  kind: "task.started",
  at,
  payload,
});

describe("collectLiveTasks", () => {
  it("keeps a backgrounded shell that never reported a terminal event", () => {
    const live = collectLiveTasks(
      rows(
        started({
          taskId: "bt8uuddjr",
          taskType: "local_bash",
          detail: "Summarize price-object CRUD permissions",
          title: "Summarize price-object CRUD permissions",
        }),
        {
          kind: "task.updated",
          at: "2026-08-13T12:07:53.917Z",
          payload: {
            taskId: "bt8uuddjr",
            taskType: "local_bash",
            isBackgrounded: true,
            title: "Summarize price-object CRUD permissions",
          },
        },
      ),
    );

    assert.equal(live.length, 1);
    const task = live[0];
    assert.equal(task?.taskId, "bt8uuddjr");
    assert.equal(task?.liveness, "monitoring");
    assert.equal(task?.taskType, "local_bash");
    assert.equal(task?.title, "Summarize price-object CRUD permissions");
    assert.equal(task?.startedAt, "2026-08-13T12:00:00.000Z");
    assert.equal(task?.lastEventAt, "2026-08-13T12:07:53.917Z");
    assert.isTrue(task?.backgrounded);
    assert.equal(foldLiveness(live), "monitoring");
  });

  it("drops a shell once its terminal row lands", () => {
    const live = collectLiveTasks(
      rows(
        started({ taskId: "bt8uuddjr", taskType: "local_bash", title: "Summarize" }),
        {
          kind: "task.updated",
          at: "2026-08-13T12:07:53.917Z",
          payload: { taskId: "bt8uuddjr", taskType: "local_bash", isBackgrounded: true },
        },
        {
          kind: "task.completed",
          at: "2026-08-13T12:43:06.397Z",
          payload: { taskId: "bt8uuddjr", taskType: "local_bash", status: "stopped" },
        },
      ),
    );

    assert.deepEqual(live, []);
    assert.equal(foldLiveness(live), null);
  });

  it("treats a cancelled status on a non-terminal row as ended", () => {
    const live = collectLiveTasks(
      rows(started({ taskId: "b1", taskType: "local_bash" }), {
        kind: "task.updated",
        at: "2026-08-13T12:43:06.396Z",
        payload: { taskId: "b1", taskType: "local_bash", status: "cancelled" },
      }),
    );

    assert.deepEqual(live, []);
  });

  it("treats an idle child as resting rather than live", () => {
    const live = collectLiveTasks(
      rows(started({ taskId: "codex-child", taskType: "codex" }), {
        kind: "task.progress",
        at: "2026-08-13T12:10:00.000Z",
        payload: { taskId: "codex-child", taskType: "codex", status: "idle" },
      }),
    );

    assert.deepEqual(live, []);
  });

  it("folds a mixed roster to working while still listing the monitor", () => {
    const live = collectLiveTasks(
      rows(
        started({ taskId: "agent-1", taskType: "local_agent", title: "Trace backend" }),
        started({ taskId: "shell-1", taskType: "local_bash", title: "Tail logs" }),
      ),
    );

    assert.equal(live.length, 2);
    assert.equal(foldLiveness(live), "working");
    assert.deepEqual(
      live.map((task) => [task.taskId, task.liveness]).toSorted(),
      [
        ["agent-1", "working"],
        ["shell-1", "monitoring"],
      ].toSorted(),
    );
  });

  it("excludes workflow member slots, which the coordinator already represents", () => {
    const live = collectLiveTasks(rows(started({ taskId: "coordinator:wf:0" })));

    assert.deepEqual(live, []);
  });

  it("excludes plan-mode bookkeeping", () => {
    const live = collectLiveTasks(rows(started({ taskId: "p1", taskType: "plan" })));

    assert.deepEqual(live, []);
  });

  it("excludes a subagent's own shell but keeps a nested agent", () => {
    const live = collectLiveTasks(
      rows(
        started({ taskId: "inner-shell", taskType: "local_bash", agentId: "agent-1" }),
        started({ taskId: "nested-agent", taskType: "local_agent", agentId: "agent-1" }),
      ),
    );

    assert.deepEqual(
      live.map((task) => task.taskId),
      ["nested-agent"],
    );
  });

  it("falls back to detail for a title and keeps metadata from later rows", () => {
    const live = collectLiveTasks(
      rows(started({ taskId: "b1", detail: "Wait for CI" }), {
        kind: "task.progress",
        at: "2026-08-13T12:20:00.000Z",
        payload: { taskId: "b1", taskType: "local_bash" },
      }),
    );

    assert.equal(live[0]?.title, "Wait for CI");
    assert.equal(live[0]?.taskType, "local_bash");
    assert.equal(live[0]?.liveness, "monitoring");
  });

  it("ignores unusable rows instead of failing the report", () => {
    const live = collectLiveTasks([
      ...rows(
        {
          kind: "task.started",
          at: "2026-08-13T12:00:00.000Z",
          payload: { taskType: "local_bash" },
        },
        {
          kind: "context-window.updated",
          at: "2026-08-13T12:00:01.000Z",
          payload: { taskId: "x" },
        },
      ),
      {
        thread_id: THREAD,
        kind: "task.started",
        created_at: "2026-08-13T12:00:02.000Z",
        payload_json: "not json",
      },
    ]);

    assert.deepEqual(live, []);
  });

  it("keeps identically named tasks in different threads apart", () => {
    const live = collectLiveTasks(
      rows(
        { ...started({ taskId: "shared", taskType: "local_bash" }), threadId: "thread-a" },
        { ...started({ taskId: "shared", taskType: "local_bash" }), threadId: "thread-b" },
        {
          kind: "task.completed",
          at: "2026-08-13T12:30:00.000Z",
          payload: { taskId: "shared" },
          threadId: "thread-a",
        },
      ),
    );

    assert.deepEqual(
      live.map((task) => task.threadId),
      ["thread-b"],
    );
  });
});

const createFixtureDatabase = Effect.fn("createThreadBackgroundFixtureDatabase")(function* (
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = path.join(baseDir, "userdata");
  yield* fs.makeDirectory(stateDir, { recursive: true });

  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE projection_thread_activities (
      activity_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`;
    yield* sql`CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, title TEXT NOT NULL)`;
    yield* sql`CREATE TABLE provider_session_runtime (
      thread_id TEXT PRIMARY KEY,
      resume_cursor_json TEXT
    )`;

    yield* sql`INSERT INTO projection_threads (thread_id, title) VALUES ('t-live', 'Stuck thread')`;
    yield* sql`INSERT INTO projection_threads (thread_id, title) VALUES ('t-quiet', 'Quiet thread')`;
    yield* sql`INSERT INTO provider_session_runtime (thread_id, resume_cursor_json)
      VALUES ('t-live', '{"resume":"session-gone"}')`;

    const activities = [
      [
        "a1",
        "t-live",
        "task.started",
        '{"taskId":"shell-1","taskType":"local_bash","title":"Tail CI"}',
        "2026-08-13T12:00:00.000Z",
      ],
      [
        "a2",
        "t-live",
        "task.updated",
        '{"taskId":"shell-1","taskType":"local_bash","isBackgrounded":true}',
        "2026-08-13T12:02:00.000Z",
      ],
      [
        "a3",
        "t-quiet",
        "task.started",
        '{"taskId":"shell-2","taskType":"local_bash","title":"Done"}',
        "2026-08-13T12:00:00.000Z",
      ],
      [
        "a4",
        "t-quiet",
        "task.completed",
        '{"taskId":"shell-2","taskType":"local_bash","status":"stopped"}',
        "2026-08-13T12:01:00.000Z",
      ],
    ] as const;
    for (const [id, threadId, kind, payload, at] of activities) {
      yield* sql`INSERT INTO projection_thread_activities
        (activity_id, thread_id, kind, summary, payload_json, created_at)
        VALUES (${id}, ${threadId}, ${kind}, ${kind}, ${payload}, ${at})`;
    }
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: path.join(stateDir, "state.sqlite") })),
  );
});

it.layer(NodeServices.layer)("runThreadBackground", (it) => {
  it.effect("reports the live task for one thread and names its orphaned session", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-thread-background-" });
      yield* createFixtureDatabase(baseDir);

      const reports = yield* runThreadBackground({ baseDir, threadId: "t-live", all: false });

      assert.equal(reports.length, 1);
      assert.equal(reports[0]?.liveness, "monitoring");
      assert.equal(reports[0]?.title, "Stuck thread");
      assert.deepEqual(
        reports[0]?.tasks.map((task) => task.taskId),
        ["shell-1"],
      );
      // The recorded session is not running, so the probe reports no pid — the
      // signal that distinguishes orphaned work from live work.
      assert.equal(reports[0]?.session?.resumeId, "session-gone");
      assert.equal(reports[0]?.session?.providerPid, null);
    }).pipe(Effect.scoped),
  );

  it.effect("returns nothing for a thread whose task already ended", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-thread-background-" });
      yield* createFixtureDatabase(baseDir);

      const reports = yield* runThreadBackground({ baseDir, threadId: "t-quiet", all: false });

      assert.equal(reports.length, 1);
      assert.equal(reports[0]?.liveness, null);
      assert.deepEqual(reports[0]?.tasks, []);
      assert.equal(reports[0]?.session, null);
    }).pipe(Effect.scoped),
  );

  it.effect("sweeps only threads with live work under --all", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-thread-background-" });
      yield* createFixtureDatabase(baseDir);

      const reports = yield* runThreadBackground({ baseDir, threadId: undefined, all: true });

      assert.deepEqual(
        reports.map((report) => report.threadId),
        ["t-live"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("falls back to T3CODE_THREAD_ID when no thread flag is given", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-thread-background-" });
      yield* createFixtureDatabase(baseDir);

      const reports = yield* runThreadBackground({
        baseDir,
        threadId: undefined,
        all: false,
      }).pipe(Effect.provideService(HostProcessEnvironment, { T3CODE_THREAD_ID: "t-live" }));

      assert.deepEqual(
        reports.map((report) => report.threadId),
        ["t-live"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("fails with a typed error when no thread can be resolved", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-thread-background-" });

      const error = yield* runThreadBackground({
        baseDir,
        threadId: undefined,
        all: false,
      }).pipe(Effect.provideService(HostProcessEnvironment, {}), Effect.flip);

      assert.equal(error._tag, "ThreadBackgroundMissingThreadError");
    }).pipe(Effect.scoped),
  );

  it.effect("fails with a typed error when the database is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-thread-background-" });

      const error = yield* runThreadBackground({
        baseDir,
        threadId: "t-live",
        all: false,
      }).pipe(Effect.flip);

      assert.equal(error._tag, "ThreadBackgroundDatabaseMissingError");
    }).pipe(Effect.scoped),
  );
});

// The `ps` parsing and the resume-id match are the only parts of the probe that
// cannot be checked against fixture data, so they are exercised against a real
// process carrying a marker argument.
describe.skipIf(process.platform === "win32")("probeSession", () => {
  const marker = "t3-thread-background-probe-marker";

  it("finds the provider process by its resume argument, and skips the probe on Windows", async () => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 5000)", `resume=${marker}`],
      { stdio: "ignore" },
    );
    try {
      // `ps` only sees the process once it is actually running.
      await new Promise((resolve) => setTimeout(resolve, 250));

      const found = probeSession(marker, process.platform);
      assert.equal(found.providerPid, child.pid);

      // Same call, same live process, but Windows has no usable `ps` — the
      // guard must short-circuit rather than report a wrong answer.
      const onWindows = probeSession(marker, "win32");
      assert.equal(onWindows.providerPid, null);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("reports no pid when the recorded session is gone", () => {
    assert.equal(probeSession("session-that-never-existed", process.platform).providerPid, null);
  });
});
