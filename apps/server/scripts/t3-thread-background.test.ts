import * as NodeServices from "@effect/platform-node/NodeServices";
// @effect-diagnostics nodeBuiltinImport:off - the probe test needs a real OS process.
import * as NodeChildProcess from "node:child_process";
import * as NodeProcess from "node:process";
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
  formatReports,
  type LiveTask,
  type ProcessInfo,
  probeSession,
  redactCommand,
  runThreadBackground,
  type SessionProbe,
  type ThreadReport,
  verdictFor,
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

  it("replays a usage tick like the registry does, rather than hiding it", () => {
    // A usage row carries no `status`, so the registry's drop-then-re-add makes
    // a trailing one revive a task a terminal row had retired — and when
    // `typedUsage` is the only state, the usage row is the only row persisted.
    // Filtering it out here would report "nothing running" for a thread whose
    // pill is still lit, which is the exact question this tool answers.
    const live = collectLiveTasks(
      rows(
        started({ taskId: "b1", taskType: "local_bash" }),
        {
          kind: "task.progress",
          at: "2026-08-13T12:10:00.000Z",
          payload: { taskId: "b1", taskType: "local_bash", status: "completed" },
        },
        {
          kind: "task.progress",
          at: "2026-08-13T12:10:01.000Z",
          payload: { taskId: "b1", taskType: "local_bash", usageSnapshot: true },
        },
      ),
    );

    assert.deepEqual(
      live.map((task) => [task.taskId, task.liveness]),
      [["b1", "monitoring"]],
    );
  });

  it("lets a task stop being backgrounded", () => {
    const live = collectLiveTasks(
      rows(
        started({ taskId: "b1", taskType: "local_bash" }),
        {
          kind: "task.updated",
          at: "2026-08-13T12:01:00.000Z",
          payload: { taskId: "b1", taskType: "local_bash", isBackgrounded: true },
        },
        {
          kind: "task.updated",
          at: "2026-08-13T12:02:00.000Z",
          payload: { taskId: "b1", taskType: "local_bash", isBackgrounded: false },
        },
      ),
    );

    assert.isFalse(live[0]?.backgrounded);
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
      created_at TEXT NOT NULL,
      sequence INTEGER
    )`;
    yield* sql`CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, title TEXT NOT NULL)`;
    yield* sql`CREATE TABLE provider_session_runtime (
      thread_id TEXT PRIMARY KEY,
      resume_cursor_json TEXT,
      provider_name TEXT
    )`;

    yield* sql`INSERT INTO projection_threads (thread_id, title) VALUES ('t-live', 'Stuck thread')`;
    yield* sql`INSERT INTO projection_threads (thread_id, title) VALUES ('t-quiet', 'Quiet thread')`;
    yield* sql`INSERT INTO projection_threads (thread_id, title) VALUES ('t-codex', 'Codex thread')`;
    // A Codex cursor carries no `resume` key, so the session cannot be probed.
    yield* sql`INSERT INTO provider_session_runtime (thread_id, resume_cursor_json, provider_name)
      VALUES ('t-codex', '{"threadId":"c-1"}', 'codex')`;
    yield* sql`INSERT INTO provider_session_runtime (thread_id, resume_cursor_json, provider_name)
      VALUES ('t-live', '{"resume":"session-gone"}', 'claudeAgent')`;

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
      [
        "a5",
        "t-codex",
        "task.started",
        '{"taskId":"shell-3","taskType":"local_bash","title":"Codex watch"}',
        "2026-08-13T12:00:00.000Z",
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

      // t-quiet's only task ended, so it is absent entirely; the two threads
      // with surviving tasks are reported with different verdicts.
      assert.deepEqual(
        reports.map((report) => [report.threadId, report.verdict]).toSorted(),
        [
          ["t-codex", "unknown"],
          ["t-live", "orphaned"],
        ].toSorted(),
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

  it.effect("prefers the exact state directory its terminal was given", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-thread-background-" });
      yield* createFixtureDatabase(baseDir);

      // A dev server's state lives in `<home>/dev`, not `<home>/userdata`, so
      // T3CODE_STATE_DIR must win over any path rebuilt from T3CODE_HOME.
      const reports = yield* runThreadBackground({
        baseDir: undefined,
        threadId: "t-live",
        all: false,
      }).pipe(
        Effect.provideService(HostProcessEnvironment, {
          T3CODE_STATE_DIR: path.join(baseDir, "userdata"),
          T3CODE_HOME: "/nonexistent/home",
        }),
      );

      assert.deepEqual(
        reports.map((report) => report.threadId),
        ["t-live"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("falls back to the T3CODE_HOME its terminal belongs to", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-thread-background-" });
      yield* createFixtureDatabase(baseDir);

      // No --base-dir: without honouring T3CODE_HOME this would open ~/.t3 and
      // report on the wrong server entirely.
      const reports = yield* runThreadBackground({
        baseDir: undefined,
        threadId: "t-live",
        all: false,
      }).pipe(Effect.provideService(HostProcessEnvironment, { T3CODE_HOME: baseDir }));

      assert.deepEqual(
        reports.map((report) => report.threadId),
        ["t-live"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("calls an unaddressable session unknown, never orphaned", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-thread-background-" });
      yield* createFixtureDatabase(baseDir);

      const reports = yield* runThreadBackground({ baseDir, threadId: "t-codex", all: false });

      assert.equal(reports[0]?.verdict, "unknown");
      assert.equal(reports[0]?.session?.outcome, "unsupported");
      assert.include(reports[0]?.session?.unsupportedReason ?? "", "codex");
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
// The `ps` parsing and the resume-id match are the only parts of the probe that
// cannot be checked against fixture data, so they are exercised against a real
// process carrying a marker argument.
const MARKER = "t3-thread-background-probe-marker";

/**
 * Spawns a process whose argv carries `resume=<marker>` and resolves once it
 * has announced itself on stdout — a readiness signal, so the test never races
 * `ps` on a timer.
 */
function withMarkerProcess<A>(
  run: (child: NodeChildProcess.ChildProcess) => A | Promise<A>,
  // The adapter spawns a fresh session as `--session-id` and a resumed one as
  // `--resume`, with either separator; the probe has to find all four.
  argv: ReadonlyArray<string> = [`--resume=${MARKER}`],
): Promise<A> {
  // `sh -c <script> <args...>` keeps the extra arguments in its own argv
  // without interpreting them, which `node -e` will not do — it rejects
  // `--resume` as an unknown option of its own.
  const child = NodeChildProcess.spawn("/bin/sh", ["-c", "echo ready; sleep 30", ...argv], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  return new Promise<void>((resolve, reject) => {
    child.stdout?.once("data", () => resolve());
    child.once("error", reject);
    child.once("exit", () => reject(new Error("marker process exited before signalling")));
  })
    .then(() => run(child))
    .finally(() => {
      child.kill("SIGKILL");
    });
}

it.layer(NodeServices.layer)("probeSession", (it) => {
  const ARGV_FORMS: ReadonlyArray<ReadonlyArray<string>> = [
    [`--resume=${MARKER}`],
    ["--resume", MARKER],
    [`--session-id=${MARKER}`],
    ["--session-id", MARKER],
  ];

  for (const argv of ARGV_FORMS) {
    it.effect(`finds the provider process spawned as \`${argv.join(" ")}\``, () =>
      Effect.gen(function* () {
        const platform = yield* HostProcessPlatform;
        if (platform === "win32") return;

        yield* Effect.promise(() =>
          withMarkerProcess((child) => {
            const found = probeSession(MARKER, { platform });
            assert.equal(found.outcome, "found");
            assert.equal(found.providerPid, child.pid);
          }, argv),
        );
      }),
    );
  }

  it.effect("ignores the id when it is not the value of a session flag", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      if (platform === "win32") return;

      yield* Effect.promise(() =>
        withMarkerProcess(() => {
          assert.equal(probeSession(MARKER, { platform }).outcome, "not-running");
        }, [`--note=resume=${MARKER}`]),
      );
    }),
  );

  it.effect("hides its own subtree, so the ps it just ran is not a live child", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;

      // The real shape this guards: run from a T3 terminal, this script is a
      // descendant of the very provider being probed, and `ps` lists itself in
      // the snapshot it produces. Injected rather than spawned because the
      // relationship cannot be reproduced from a test runner.
      const selfPid = NodeProcess.pid;
      const row = (pid: number, ppid: number, command: string): ProcessInfo => ({
        pid,
        ppid,
        elapsed: "01:00",
        cpuTime: "0:00.10",
        command,
      });
      const processes = [
        row(4242, 1, `claude --resume=${MARKER}`),
        row(selfPid, 4242, "node t3-thread-background.ts"),
        row(4244, selfPid, "ps -Awwo pid=,ppid=,etime=,time=,command="),
        row(4245, 4242, "python3 runaway.py"),
      ];

      const probe = probeSession(MARKER, { platform, processes });

      assert.equal(probe.providerPid, 4242);
      assert.deepEqual(
        probe.children.map((child) => child.pid),
        [4245],
      );
      assert.equal(probe.hiddenChildren, 1);
    }),
  );

  it.effect("reports a missing session as not-running, distinct from unsupported", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      if (platform === "win32") return;

      const probe = probeSession("session-that-never-existed", { platform });
      assert.equal(probe.outcome, "not-running");
      assert.equal(probe.providerPid, null);
    }),
  );

  it.effect("treats an unaddressable session as unsupported, not as orphaned", () =>
    Effect.gen(function* () {
      // A Codex cursor has no `resume` key, so `resumeIdFromCursor` yields null.
      const probe = probeSession(null, {
        platform: yield* HostProcessPlatform,
        providerName: "codex",
      });
      assert.equal(probe.outcome, "unsupported");
      // States what was read, rather than asserting a provider it did not read.
      assert.match(probe.unsupportedReason ?? "", /no command-line session id/);
      assert.include(probe.unsupportedReason ?? "", "codex");
    }),
  );
});

describe("redactCommand", () => {
  it("blanks credentials that agent-run commands carry", () => {
    assert.equal(
      redactCommand('claude --mcp-config {"headers":{"Authorization":"Bearer sk-abc123"}}'),
      "claude --mcp-config <redacted>",
    );
    assert.equal(
      redactCommand("curl -H 'Authorization: Bearer sk-live-9'"),
      "curl -H 'Authorization: Bearer <redacted>",
    );
    assert.equal(
      redactCommand("psql postgres://user:hunter2@db/x"),
      "psql postgres://user:<redacted>@db/x",
    );
    assert.equal(redactCommand("deploy --api-key=abcdef"), "deploy --api-key=<redacted>");
    assert.equal(redactCommand("deploy --api-key sk-live-secret"), "deploy --api-key <redacted>");
    assert.equal(
      redactCommand("curl -H 'Authorization: Basic dXNlcjpwYXNz'"),
      "curl -H 'Authorization: Basic <redacted>",
    );
    assert.notInclude(redactCommand("tool --password='two words'"), "words");
    assert.notInclude(redactCommand(`tool --config '{"token":"secret"}'`), "secret");
    // Redacting the config blob must not swallow the flags that follow it,
    // which are usually why the process is being looked at.
    assert.equal(
      redactCommand('claude --mcp-config {"a":1} --permission-mode bypass --add-dir /repo'),
      "claude --mcp-config <redacted> --permission-mode bypass --add-dir /repo",
    );
    assert.equal(redactCommand("rg -n resume src"), "rg -n resume src");
  });
});

describe("verdictFor and formatReports", () => {
  const task: LiveTask = {
    threadId: "t1",
    taskId: "shell-1",
    taskType: "local_bash",
    title: "Tail CI",
    liveness: "monitoring",
    startedAt: "2026-08-13T12:00:00.000Z",
    lastEventAt: "2026-08-13T12:02:00.000Z",
    backgrounded: true,
  };
  const report = (
    verdict: ThreadReport["verdict"],
    session: SessionProbe | null,
  ): ThreadReport => ({
    threadId: "t1",
    title: "Demo",
    liveness: "monitoring",
    verdict,
    tasks: [task],
    session,
  });
  const probe = (over: Partial<SessionProbe>): SessionProbe => ({
    outcome: "found",
    unsupportedReason: null,
    resumeId: "s1",
    providerPid: 42,
    children: [],
    hiddenChildren: 0,
    ...over,
  });

  it("lets the probe decide the verdict", () => {
    assert.equal(verdictFor("monitoring", probe({ outcome: "found" })), "live");
    assert.equal(
      verdictFor("monitoring", probe({ outcome: "not-running", providerPid: null })),
      "orphaned",
    );
    assert.equal(
      verdictFor("monitoring", probe({ outcome: "unsupported", unsupportedReason: "no ps" })),
      "unknown",
    );
    assert.equal(verdictFor(null, null), "idle");
  });

  it("headlines an orphan as ORPHANED rather than as live work", () => {
    const text = formatReports([
      report("orphaned", probe({ outcome: "not-running", providerPid: null })),
    ]);
    assert.match(text, /^ORPHANED \(monitoring\)/);
    assert.include(text, "stale bookkeeping, not live work");
    assert.notMatch(text, /^MONITORING/m);
  });

  it("says it could not tell when the probe cannot run", () => {
    const text = formatReports([
      report(
        "unknown",
        probe({ outcome: "unsupported", unsupportedReason: "`ps` is unavailable" }),
      ),
    ]);
    assert.match(text, /^UNKNOWN \(monitoring\)/);
    assert.include(text, "cannot tell whether this is still running");
    assert.notInclude(text, "orphaned");
  });

  it("headlines confirmed work as LIVE and redacts nothing it was not given", () => {
    const text = formatReports([
      report(
        "live",
        probe({
          children: [
            { pid: 7, ppid: 42, elapsed: "31:00", cpuTime: "30:00", command: "python3 -" },
          ],
          hiddenChildren: 3,
        }),
      ),
    ]);
    assert.match(text, /^LIVE \(monitoring\)/);
    assert.include(text, "pid 7 · up 31:00 · cpu 30:00 · python3 -");
    assert.include(text, "3 hidden");
  });

  it("says nothing at all when no thread has live work", () => {
    assert.equal(formatReports([report("idle", null)]), "No live background work.");
  });
});
