import { assert, it } from "@effect/vitest";

import {
  buildProgressRows,
  buildRemoteCommand,
  buildRemoteScript,
  buildSelectionChoices,
  CancellationController,
  classifyRemoteExit,
  createDefaultDependencies,
  createDryRunRunner,
  createExplicitPlan,
  createProgressReporter,
  decidePreflights,
  executePreparedUpdatePlan,
  executeUpdatePlan,
  failureLogPaths,
  getEligibleRemoteTargets,
  MachineUpdateError,
  main,
  normalizeHostname,
  parseCliArgs,
  parseSimulatedFailures,
  planFromChoices,
  preflightUpdatePlan,
  prepareUpdatePlan,
  printSummary,
  promptShowFailureLogs,
  reduceSelector,
  resolveLocalMachine,
  resultExitCode,
  selectUpdatePlan,
  selectorKey,
  shouldPromptForFailureLogs,
  validateSelectedHosts,
  validateSimulatedFailures,
  type CommandResult,
  type CommandRunner,
  type RunRequest,
  type SelectorState,
  type TerminalInput,
  type TerminalOutput,
  type UpdateDependencies,
} from "./machine-update.ts";

const ok = (): CommandResult => ({
  exitCode: 0,
  stdoutTail: "",
  stderrTail: "",
  cancelled: false,
});

function testDependencies(runner: CommandRunner, events: string[] = []): UpdateDependencies {
  return {
    runner,
    homeDir: "/home/test",
    env: { T3CODE_REPO: "/repo" },
    pathExists: (path) => path === "/repo/.git",
    log: (line) => events.push(line),
    defensiveRevalidation: false,
    inspectPlan: async (plan) => [
      ...plan.remoteTargets.map((target) => ({
        target,
        local: false,
        checkout: "/repo",
        branch: "dev",
        dirty: false,
        stage: { stage: "preflight" as const, status: "OK" as const },
      })),
      ...(plan.local
        ? [
            {
              target: plan.local.machine,
              local: true,
              checkout: "/repo",
              branch: "dev",
              dirty: false,
              stage: { stage: "preflight" as const, status: "OK" as const },
            },
          ]
        : []),
    ],
  };
}

function fakeTerminal(keys: ReadonlyArray<string>): {
  readonly input: TerminalInput;
  readonly output: TerminalOutput;
  readonly written: () => string;
  readonly rawModes: ReadonlyArray<boolean>;
} {
  let listener: ((data: Buffer) => void) | undefined;
  let written = "";
  const rawModes: boolean[] = [];
  const input: TerminalInput = {
    isTTY: true,
    setRawMode(mode) {
      assert.equal(this, input);
      rawModes.push(mode);
    },
    resume: () => undefined,
    pause: () => undefined,
    on: (_event, nextListener) => {
      listener = nextListener;
      queueMicrotask(() => {
        for (const key of keys) listener?.(Buffer.from(key));
      });
    },
    off: () => undefined,
  };
  return {
    input,
    output: { isTTY: true, write: (value) => (written += value) },
    written: () => written,
    rawModes,
  };
}

it("normalizes known hostnames and fails safely for unknown machines", () => {
  assert.equal(normalizeHostname("SpaceMac.local"), "spacemac");
  assert.equal(resolveLocalMachine("SpaceMac.local"), "space-mac");
  assert.equal(resolveLocalMachine("unknown", "grey-mac"), "grey-mac");
  assert.throws(() => resolveLocalMachine("build-box"), MachineUpdateError);
  assert.throws(() => resolveLocalMachine("constructor", "constructor"), MachineUpdateError);
});

it("builds one unified unchecked selector with independent local rows and macOS iOS gating", async () => {
  assert.deepStrictEqual(getEligibleRemoteTargets("space-mac", ["grey-mac", "ubuntu-dell", "g"]), [
    "grey-mac",
    "ubuntu-dell",
  ]);
  const macChoices = buildSelectionChoices(["grey-mac", "ubuntu-dell"], "space-mac", "darwin");
  assert.deepStrictEqual(
    macChoices.map(({ kind, label }) => [kind, label]),
    [
      ["remote-desktop", "grey-mac desktop (remote)"],
      ["remote-desktop", "ubuntu-dell desktop (remote)"],
      ["local-desktop", "space-mac desktop (local)"],
      ["local-ios", "space-mac iOS (local)"],
    ],
  );
  assert.deepStrictEqual(
    buildSelectionChoices(["grey-mac"], "ubuntu-dell", "linux").map(({ kind }) => kind),
    ["remote-desktop", "local-desktop"],
  );

  const empty = fakeTerminal(["\r"]);
  assert.deepStrictEqual(await selectUpdatePlan(macChoices, empty.input, empty.output), {
    remoteTargets: [],
  });
  assert.include(empty.written(), "[ ] space-mac desktop (local)");
  assert.include(empty.written(), "[ ] space-mac iOS (local)");
  assert.deepStrictEqual(empty.rawModes, [true, false]);

  const iosOnly = fakeTerminal(["[B", "[B", "[B", " ", "\r"]);
  assert.deepStrictEqual(await selectUpdatePlan(macChoices, iosOnly.input, iosOnly.output), {
    remoteTargets: [],
    local: { machine: "space-mac", desktop: false, ios: true },
  });
  assert.equal((iosOnly.written().match(/Select updates/gu) ?? []).length >= 1, true);
  assert.notInclude(iosOnly.written(), "Build and install local iOS");
});

it("reduces selector arrows and Space without a real TTY", () => {
  let state: SelectorState = { cursor: 0, selected: new Set<number>() };
  state = reduceSelector(state, selectorKey("[B"), 3);
  assert.equal(state.cursor, 1);
  state = reduceSelector(state, selectorKey(" "), 3);
  assert.deepStrictEqual([...state.selected], [1]);
  state = reduceSelector(state, selectorKey("[A"), 3);
  assert.equal(state.cursor, 0);
  assert.equal(selectorKey("\r"), "confirm");
  assert.equal(selectorKey("q"), "cancel");
  assert.equal(selectorKey(""), "interrupt");
});

it("parses complete explicit plans and selection flags", () => {
  const options = parseCliArgs([
    "--host",
    "grey-mac",
    "--host=ubuntu-dell",
    "--include-local-desktop",
    "--no-local-ios",
    "--show-failure-logs",
    "--dry-run",
    "--fail",
    "grey-mac:pull",
  ]);
  assert.deepStrictEqual(options, {
    hosts: ["grey-mac", "ubuntu-dell"],
    includeLocalDesktop: true,
    excludeLocalDesktop: false,
    includeLocalIos: false,
    excludeLocalIos: true,
    localMachine: undefined,
    dryRun: true,
    simulatedFailures: ["grey-mac:pull"],
    showFailureLogs: true,
    help: false,
    explicitSelection: true,
  });
  assert.deepStrictEqual(
    createExplicitPlan(options, "space-mac", "darwin", ["grey-mac", "ubuntu-dell"]),
    {
      remoteTargets: ["grey-mac", "ubuntu-dell"],
      local: { machine: "space-mac", desktop: true, ios: false },
    },
  );
  assert.deepStrictEqual(
    createExplicitPlan(parseCliArgs(["--no-local-desktop"]), "space-mac", "darwin", ["grey-mac"]),
    { remoteTargets: [] },
  );
  assert.throws(
    () => createExplicitPlan(parseCliArgs(["--include-local-ios"]), "ubuntu-dell", "linux", []),
    /only available on macOS/,
  );
  assert.throws(() => parseCliArgs(["--fail", "grey-mac:pull"]), /only be used/);
  assert.throws(
    () => parseCliArgs(["--include-local-desktop", "--no-local-desktop"]),
    /cannot be combined/,
  );
  assert.throws(() => parseCliArgs(["--wat"]), /Unknown option/);
});

it("maps selected rows to independent local desktop/iOS plans", () => {
  const choices = buildSelectionChoices(["grey-mac"], "space-mac", "darwin");
  assert.deepStrictEqual(planFromChoices(choices, new Set(["local:desktop"])), {
    remoteTargets: [],
    local: { machine: "space-mac", desktop: true, ios: false },
  });
  assert.deepStrictEqual(planFromChoices(choices, new Set(["remote:grey-mac", "local:ios"])), {
    remoteTargets: ["grey-mac"],
    local: { machine: "space-mac", desktop: false, ios: true },
  });
});

it("validates selected hosts and selected-surface simulated failures", () => {
  assert.deepStrictEqual(
    validateSelectedHosts(["grey-mac", "grey-mac"], ["grey-mac", "ubuntu-dell"]),
    ["grey-mac"],
  );
  assert.throws(() => validateSelectedHosts(["space-mac"], ["grey-mac"]), /not eligible/);
  validateSimulatedFailures(parseSimulatedFailures(["space-mac:desktop"]), {
    remoteTargets: [],
    local: { machine: "space-mac", desktop: true, ios: false },
  });
  assert.throws(
    () =>
      validateSimulatedFailures(parseSimulatedFailures(["space-mac:ios"]), {
        remoteTargets: [],
        local: { machine: "space-mac", desktop: true, ios: false },
      }),
    /local iOS is not selected/,
  );
  assert.throws(
    () =>
      validateSimulatedFailures(parseSimulatedFailures(["grey-mac:ios"]), {
        remoteTargets: ["grey-mac"],
      }),
    /remote targets do not run iOS/,
  );
});

it("constructs and classifies the remote desktop command", () => {
  const command = buildRemoteCommand("grey-mac");
  assert.equal(command.command, "ssh");
  assert.deepStrictEqual(command.args.slice(0, 12), [
    "-n",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "grey-mac",
    "zsh",
    "-lc",
  ]);
  assert.match(command.args[12]!, /^'.*'$/su);
  const script = buildRemoteScript();
  assert.include(script, "zoxide query t3code");
  assert.include(script, "git status --porcelain=v1 --untracked-files=all");
  assert.include(script, "git switch dev || exit 46");
  assert.include(script, "git pull --ff-only || exit 42");
  assert.include(script, "pnpm install || exit 43");
  assert.include(script, "pnpm run install:desktop:dev || exit 44");
  assert.isUndefined(classifyRemoteExit(0));
  assert.equal(classifyRemoteExit(42), "pull");
  assert.equal(classifyRemoteExit(46), "preflight");
  assert.equal(classifyRemoteExit(255), "transport");
  assert.equal(classifyRemoteExit(9), "remote");
});

it("starts remote lanes and the local lane concurrently, while preserving summary order", async () => {
  const starts: string[] = [];
  const resolvers = new Map<string, (result: CommandResult) => void>();
  const runner: CommandRunner = {
    dryRun: false,
    cancel: () => undefined,
    run: (request) => {
      const key = `${request.target}:${request.stage}`;
      starts.push(key);
      return new Promise((resolve) => resolvers.set(key, resolve));
    },
  };
  const promise = executeUpdatePlan(
    {
      remoteTargets: ["grey-mac", "ubuntu-dell"],
      local: { machine: "space-mac", desktop: true, ios: false },
    },
    testDependencies(runner),
  );
  for (let index = 0; index < 5 && starts.length < 3; index += 1) await Promise.resolve();
  assert.sameMembers(starts, ["grey-mac:remote", "ubuntu-dell:remote", "space-mac:pull"]);
  resolvers.get("ubuntu-dell:remote")?.(ok());
  resolvers.get("grey-mac:remote")?.(ok());
  resolvers.get("space-mac:pull")?.(ok());
  await Promise.resolve();
  resolvers.get("space-mac:dependencies")?.(ok());
  await Promise.resolve();
  resolvers.get("space-mac:desktop")?.(ok());
  const execution = await promise;
  assert.deepStrictEqual(
    execution.results.map(({ label }) => label),
    ["grey-mac desktop", "ubuntu-dell desktop", "space-mac desktop"],
  );
});

it("shares local prep, serializes surfaces, and lets iOS run after desktop failure", async () => {
  const requests: RunRequest[] = [];
  const runner: CommandRunner = {
    dryRun: false,
    cancel: () => undefined,
    run: async (request) => {
      requests.push(request);
      return request.stage === "desktop"
        ? { ...ok(), exitCode: 12, stderrTail: "desktop failed" }
        : ok();
    },
  };
  const execution = await executeUpdatePlan(
    {
      remoteTargets: [],
      local: { machine: "space-mac", desktop: true, ios: true },
    },
    testDependencies(runner),
  );
  assert.deepStrictEqual(
    requests.map(({ stage }) => stage),
    ["pull", "dependencies", "desktop", "ios"],
  );
  assert.isTrue(requests.every((request) => request.interactiveTerminal === undefined));
  assert.deepStrictEqual(
    execution.results[0]?.stages.map(({ stage, status }) => [stage, status]),
    [
      ["preflight", "OK"],
      ["checkout", "OK"],
      ["pull", "OK"],
      ["dependencies", "OK"],
      ["desktop", "FAILED"],
      ["ios", "OK"],
    ],
  );
  assert.equal(resultExitCode(execution), 1);
});

it("hands only real TTY local iOS execution to the terminal", async () => {
  const terminal = fakeTerminal([]);
  const requests: RunRequest[] = [];
  const progress: string[] = [];
  const runner: CommandRunner = {
    dryRun: false,
    cancel: () => undefined,
    run: async (request) => {
      requests.push(request);
      progress.push(`run:${request.stage}:${String(request.interactiveTerminal === true)}`);
      return ok();
    },
  };
  const execution = await executeUpdatePlan(
    {
      remoteTargets: [],
      local: { machine: "space-mac", desktop: true, ios: true },
    },
    {
      ...testDependencies(runner),
      input: terminal.input,
      output: terminal.output,
      progress: {
        start: () => undefined,
        stage: (_id, stage) => progress.push(`stage:${stage}`),
        finish: (_id, status) => progress.push(`finish:${status}`),
        suspend: () => progress.push("suspend"),
        resume: () => progress.push("resume"),
        close: () => undefined,
      },
    },
  );

  assert.deepStrictEqual(
    requests.map(({ stage, interactiveTerminal }) => [stage, interactiveTerminal]),
    [
      ["pull", undefined],
      ["dependencies", undefined],
      ["desktop", undefined],
      ["ios", true],
    ],
  );
  assert.deepStrictEqual(progress.slice(-5), [
    "stage:ios",
    "suspend",
    "run:ios:true",
    "resume",
    "finish:OK",
  ]);
  assert.deepStrictEqual(terminal.rawModes, [false]);
  assert.equal(resultExitCode(execution), 0);
});

it("restores terminal ownership when interactive iOS execution rejects", async () => {
  const terminal = fakeTerminal([]);
  const progress: string[] = [];
  const failure = new Error("spawn failed");
  const runner: CommandRunner = {
    dryRun: false,
    cancel: () => progress.push("cancel"),
    run: async (request) => {
      if (request.stage === "ios") throw failure;
      return ok();
    },
  };

  let caught: unknown;
  try {
    await executeUpdatePlan(
      {
        remoteTargets: [],
        local: { machine: "space-mac", desktop: false, ios: true },
      },
      {
        ...testDependencies(runner),
        input: terminal.input,
        output: terminal.output,
        progress: {
          start: () => undefined,
          stage: () => undefined,
          finish: () => undefined,
          suspend: () => progress.push("suspend"),
          resume: () => progress.push("resume"),
          close: () => undefined,
        },
      },
    );
  } catch (error) {
    caught = error;
  }

  assert.equal(caught, failure);
  assert.deepStrictEqual(progress, ["suspend", "resume", "cancel"]);
  assert.deepStrictEqual(terminal.rawModes, [false]);
});

it("prep failure skips both selected local surfaces", async () => {
  const requests: RunRequest[] = [];
  const runner: CommandRunner = {
    dryRun: false,
    cancel: () => undefined,
    run: async (request) => {
      requests.push(request);
      return request.stage === "pull" ? { ...ok(), exitCode: 7 } : ok();
    },
  };
  const execution = await executeUpdatePlan(
    {
      remoteTargets: [],
      local: { machine: "space-mac", desktop: true, ios: true },
    },
    testDependencies(runner),
  );
  assert.deepStrictEqual(
    requests.map(({ stage }) => stage),
    ["pull"],
  );
  assert.deepStrictEqual(
    execution.results[0]?.stages.map(({ stage, status }) => [stage, status]),
    [
      ["preflight", "OK"],
      ["checkout", "OK"],
      ["pull", "FAILED"],
      ["dependencies", "SKIPPED"],
      ["desktop", "SKIPPED"],
      ["ios", "SKIPPED"],
    ],
  );
});

it("reports quiet progress without forwarding captured subprocess output", async () => {
  const progress: string[] = [];
  const runner: CommandRunner = {
    dryRun: false,
    cancel: () => undefined,
    run: async () => ({ ...ok(), stdoutTail: "hidden stdout", stderrTail: "hidden stderr" }),
  };
  const execution = await executeUpdatePlan(
    { remoteTargets: ["grey-mac"] },
    {
      ...testDependencies(runner),
      progress: {
        start: (_id, label, stage) => progress.push(`start:${label}:${stage}`),
        stage: () => undefined,
        finish: (_id, status) => progress.push(`finish:${status}`),
        suspend: () => undefined,
        resume: () => undefined,
        close: () => progress.push("close"),
      },
    },
  );
  assert.deepStrictEqual(progress, ["start:grey-mac desktop:checkout", "finish:OK"]);
  assert.isUndefined(execution.results[0]?.stages[0]?.tail);
});

it("suspends TTY progress redraws while an interactive child owns the terminal", () => {
  let written = "";
  const reporter = createProgressReporter(
    [
      ["remote-grey-mac", "grey-mac desktop"],
      ["local-space-mac", "space-mac iOS"],
    ],
    { isTTY: true, write: (value) => (written += value) },
  );

  reporter.suspend();
  const suspendedOutput = written;
  reporter.stage("remote-grey-mac", "pull");
  reporter.finish("local-space-mac", "OK");
  assert.equal(written, suspendedOutput);

  reporter.resume();
  const resumedOutput = written.slice(suspendedOutput.length);
  assert.include(resumedOutput, "RUNNING grey-mac desktop — pull");
  assert.include(resumedOutput, "OK space-mac iOS — OK");
  assert.isTrue(suspendedOutput.endsWith("[2A[J[?25h"));

  reporter.close();
  const closedOutput = written;
  reporter.close();
  assert.equal(written, closedOutput);
  assert.isTrue(written.endsWith("[?25h"));
});

it("retains failure log paths and prompts only for TTY failures unless forced", () => {
  const results = [
    {
      target: "grey-mac" as const,
      label: "grey-mac desktop",
      logPath: "/logs/grey.log",
      hasLog: true,
      stages: [{ stage: "pull" as const, status: "FAILED" as const }],
    },
  ];
  assert.deepStrictEqual(failureLogPaths(results), ["/logs/grey.log"]);
  assert.isTrue(shouldPromptForFailureLogs(results, true, true, false));
  assert.isFalse(shouldPromptForFailureLogs(results, false, true, false));
  assert.isFalse(shouldPromptForFailureLogs(results, true, false, false));
  assert.isFalse(shouldPromptForFailureLogs(results, true, true, true));
  assert.deepStrictEqual(
    failureLogPaths([{ ...results[0]!, stages: [{ stage: "pull", status: "CANCELLED" }] }]),
    [],
  );
});

it("treats q at the optional log prompt as no", async () => {
  const terminal = fakeTerminal(["q"]);
  assert.isFalse(await promptShowFailureLogs(terminal.input, terminal.output));
  assert.include(terminal.written(), "Show full logs for failed jobs?");
  assert.deepStrictEqual(terminal.rawModes, [true, false]);
});

it("keeps dry-run dependencies free of log paths", () => {
  const dependencies = createDefaultDependencies(createDryRunRunner([]));
  assert.isUndefined(dependencies.logRoot);
  assert.isUndefined(dependencies.runId);
});

it("preserves dry-run commands on TTY output", async () => {
  let written = "";
  const exitCode = await main(
    ["--local-machine", "space-mac", "--include-local-desktop", "--dry-run"],
    {
      isTTY: true,
      setRawMode: () => undefined,
      resume: () => undefined,
      pause: () => undefined,
      on: () => undefined,
      off: () => undefined,
    },
    { isTTY: true, write: (value) => (written += value) },
    "darwin",
  );
  assert.equal(exitCode, 0);
  assert.include(written, "$ 'git' 'pull' '--ff-only'");
  assert.include(written, "$ 'pnpm' 'run' 'install:desktop:dev'");
  assert.notInclude(written, "[1A");
});

it("cancels owned work and marks unfinished jobs cancelled", async () => {
  let resolveRun: ((result: CommandResult) => void) | undefined;
  let cancelCalls = 0;
  const runner: CommandRunner = {
    dryRun: false,
    cancel: () => {
      cancelCalls += 1;
      resolveRun?.({ exitCode: 130, stdoutTail: "", stderrTail: "", cancelled: true });
    },
    run: () => new Promise((resolve) => (resolveRun = resolve)),
  };
  const cancellation = new CancellationController();
  const promise = executeUpdatePlan(
    { remoteTargets: ["grey-mac"] },
    testDependencies(runner),
    cancellation,
  );
  await Promise.resolve();
  cancellation.cancel();
  const execution = await promise;
  assert.equal(cancelCalls, 1);
  assert.isTrue(execution.cancelled);
  assert.equal(execution.results[0]?.stages[0]?.status, "CANCELLED");
  assert.equal(resultExitCode(execution), 130);
});

it("runs every preflight concurrently before starting any mutation", async () => {
  const starts: string[] = [];
  const preflightResolvers = new Map<string, (result: CommandResult) => void>();
  const runner: CommandRunner = {
    dryRun: false,
    cancel: () => undefined,
    run: (request) => {
      const key = `${request.target}:${request.stage}`;
      starts.push(key);
      if (request.stage === "preflight" && request.target !== "space-mac") {
        return new Promise((resolve) => preflightResolvers.set(request.target, resolve));
      }
      if (request.stage === "preflight") {
        return Promise.resolve({
          ...ok(),
          stdoutTail: request.args.includes("symbolic-ref") ? "dev\n" : "",
        });
      }
      return Promise.resolve(ok());
    },
  };
  const dependencies = {
    ...testDependencies(runner),
    defensiveRevalidation: false,
    inspectPlan: undefined,
  };
  const promise = executeUpdatePlan(
    {
      remoteTargets: ["grey-mac", "ubuntu-dell"],
      local: { machine: "space-mac", desktop: true, ios: false },
    },
    dependencies,
  );
  await Promise.resolve();
  assert.sameMembers(starts, [
    "grey-mac:preflight",
    "ubuntu-dell:preflight",
    "space-mac:preflight",
  ]);
  assert.isFalse(starts.some((value) => value.endsWith(":remote") || value.endsWith(":pull")));
  preflightResolvers.get("grey-mac")?.({
    ...ok(),
    stdoutTail: ["", "__T3_PREFLIGHT_V1__", "/repo", "dev", "0", ""].join("\0"),
  });
  preflightResolvers.get("ubuntu-dell")?.({
    ...ok(),
    stdoutTail: ["", "__T3_PREFLIGHT_V1__", "/repo", "dev", "0", ""].join("\0"),
  });
  await promise;
  assert.isTrue(starts.some((value) => value === "grey-mac:remote"));
  assert.isTrue(starts.some((value) => value === "space-mac:pull"));
});

it("derives remote dirty state and tolerates shell startup output", async () => {
  const runner: CommandRunner = {
    dryRun: false,
    cancel: () => undefined,
    run: async () => ({
      ...ok(),
      stdoutTail: `startup banner\n${["", "__T3_PREFLIGHT_V1__", "/repo", "dev", "1", ""].join(
        "\0",
      )}`,
    }),
  };
  const preflights = await preflightUpdatePlan(
    { remoteTargets: ["grey-mac"] },
    testDependencies(runner),
  );
  assert.deepStrictEqual(preflights[0]?.stage, {
    stage: "preflight",
    status: "FAILED",
    detail: "checkout is dirty",
  });
});

it("batches clean non-dev approvals unchecked and skips declined targets", async () => {
  const terminal = fakeTerminal([" ", "\r"]);
  const decisions = await decidePreflights(
    [
      {
        target: "grey-mac",
        local: false,
        checkout: "/grey",
        branch: "main",
        dirty: false,
        stage: { stage: "preflight", status: "OK" },
      },
      {
        target: "ubuntu-dell",
        local: false,
        checkout: "/ubuntu",
        branch: "feature",
        dirty: false,
        stage: { stage: "preflight", status: "OK" },
      },
    ],
    terminal.input,
    terminal.output,
  );
  assert.include(terminal.written(), "[ ] grey-mac (main → dev)");
  assert.include(terminal.written(), "[ ] ubuntu-dell (feature → dev)");
  assert.deepStrictEqual(
    decisions.map(({ preflight, approved, skipDetail }) => [
      preflight.target,
      approved,
      skipDetail,
    ]),
    [
      ["grey-mac", true, undefined],
      ["ubuntu-dell", false, "dev switch declined"],
    ],
  );
});

it("never mutates a declined clean non-dev target", async () => {
  const requests: RunRequest[] = [];
  const runner: CommandRunner = {
    dryRun: false,
    cancel: () => undefined,
    run: async (request) => {
      requests.push(request);
      return ok();
    },
  };
  const execution = await executeUpdatePlan(
    { remoteTargets: ["grey-mac"] },
    {
      ...testDependencies(runner),
      inspectPlan: async () => [
        {
          target: "grey-mac",
          local: false,
          checkout: "/repo",
          branch: "main",
          dirty: false,
          stage: { stage: "preflight", status: "OK" },
        },
      ],
    },
  );
  assert.deepStrictEqual(requests, []);
  assert.equal(resultExitCode(execution), 0);
  assert.equal(execution.results[0]?.stages[0]?.status, "SKIPPED");
});

it("cancels a pending preflight without starting mutation", async () => {
  let resolvePreflight: ((result: CommandResult) => void) | undefined;
  let cancelCalls = 0;
  const mutations: RunRequest[] = [];
  const runner: CommandRunner = {
    dryRun: false,
    cancel: () => {
      cancelCalls += 1;
      resolvePreflight?.({ ...ok(), exitCode: 130, cancelled: true });
    },
    run: (request) => {
      if (request.stage !== "preflight") {
        mutations.push(request);
        return Promise.resolve(ok());
      }
      return new Promise((resolve) => (resolvePreflight = resolve));
    },
  };
  const cancellation = new CancellationController();
  const dependencies = { ...testDependencies(runner), inspectPlan: undefined };
  const promise = executeUpdatePlan({ remoteTargets: ["grey-mac"] }, dependencies, cancellation);
  await Promise.resolve();
  cancellation.cancel();
  const execution = await promise;
  assert.equal(cancelCalls, 1);
  assert.deepStrictEqual(mutations, []);
  assert.equal(execution.results[0]?.stages[0]?.status, "CANCELLED");
  assert.equal(resultExitCode(execution), 130);
});

it("cancels the branch-switch prompt and restores terminal state", async () => {
  const terminal = fakeTerminal([]);
  const runner: CommandRunner = {
    dryRun: false,
    cancel: () => undefined,
    run: async () => ok(),
  };
  const cancellation = new CancellationController();
  const pending = prepareUpdatePlan(
    { remoteTargets: ["grey-mac"] },
    {
      ...testDependencies(runner),
      input: terminal.input,
      output: terminal.output,
      inspectPlan: async () => [
        {
          target: "grey-mac",
          local: false,
          checkout: "/repo",
          branch: "main",
          dirty: false,
          stage: { stage: "preflight", status: "OK" },
        },
      ],
    },
    cancellation,
  );
  const outcome = pending.then(
    () => "resolved",
    (error: unknown) => error,
  );
  await Promise.resolve();
  cancellation.cancel();
  const error = await outcome;
  assert.instanceOf(error, MachineUpdateError);
  assert.match((error as MachineUpdateError).message, /Cancelled/);
  assert.deepStrictEqual(terminal.rawModes, [true, false]);
});

it("builds progress rows only for approved targets", () => {
  assert.deepStrictEqual(
    buildProgressRows({
      plan: {
        remoteTargets: ["grey-mac", "ubuntu-dell"],
        local: { machine: "space-mac", desktop: true, ios: true },
      },
      decisions: [
        {
          approved: true,
          preflight: {
            target: "grey-mac",
            local: false,
            stage: { stage: "preflight", status: "OK" },
          },
        },
        {
          approved: false,
          preflight: {
            target: "ubuntu-dell",
            local: false,
            stage: { stage: "preflight", status: "FAILED" },
          },
        },
        {
          approved: false,
          preflight: {
            target: "space-mac",
            local: true,
            stage: { stage: "preflight", status: "SKIPPED" },
          },
        },
      ],
    }),
    [["remote-grey-mac", "grey-mac desktop"]],
  );
});

it("finishes branch decisions before progress and mutation start", async () => {
  const terminal = fakeTerminal([" ", "\r"]);
  const events: string[] = [];
  const runner: CommandRunner = {
    dryRun: false,
    cancel: () => undefined,
    run: async (request) => {
      events.push(`run:${request.stage}`);
      return ok();
    },
  };
  const dependencies: UpdateDependencies = {
    ...testDependencies(runner),
    input: terminal.input,
    output: terminal.output,
    inspectPlan: async () => [
      {
        target: "grey-mac",
        local: false,
        checkout: "/repo",
        branch: "main",
        dirty: false,
        stage: { stage: "preflight", status: "OK" },
      },
    ],
  };
  const prepared = await prepareUpdatePlan({ remoteTargets: ["grey-mac"] }, dependencies);
  assert.deepStrictEqual(events, []);
  assert.notInclude(terminal.written(), "[1A");
  await executePreparedUpdatePlan(prepared, dependencies);
  assert.deepStrictEqual(events, ["run:remote"]);
});

it("prints and retains logs only for failed targets", () => {
  const lines: string[] = [];
  printSummary(
    [
      {
        target: "grey-mac",
        label: "grey-mac desktop",
        logPath: "/logs/declined.log",
        hasLog: true,
        stages: [{ stage: "preflight", status: "SKIPPED" }],
      },
      {
        target: "ubuntu-dell",
        label: "ubuntu-dell desktop",
        logPath: "/logs/failed.log",
        hasLog: true,
        stages: [{ stage: "preflight", status: "FAILED" }],
      },
    ],
    (line) => lines.push(line),
  );
  assert.notInclude(lines.join("\n"), "/logs/declined.log");
  assert.include(lines.join("\n"), "/logs/failed.log");
});

it("skips clean non-dev targets non-interactively and fails dirty targets", async () => {
  const decisions = await decidePreflights(
    [
      {
        target: "grey-mac",
        local: false,
        checkout: "/grey",
        branch: "main",
        dirty: false,
        stage: { stage: "preflight", status: "OK" },
      },
      {
        target: "ubuntu-dell",
        local: false,
        checkout: "/ubuntu",
        branch: "dev",
        dirty: true,
        stage: { stage: "preflight", status: "FAILED", detail: "checkout is dirty" },
      },
    ],
    {
      isTTY: false,
      resume: () => undefined,
      pause: () => undefined,
      on: () => undefined,
      off: () => undefined,
    },
    { isTTY: false, write: () => undefined },
  );
  assert.equal(decisions[0]?.skipDetail, "non-TTY non-dev target");
  assert.isFalse(decisions[0]?.approved);
  assert.isFalse(decisions[1]?.approved);
});

it("dry-run ignores the real checkout and defaults to synthetic clean dev", async () => {
  const lines: string[] = [];
  const execution = await executeUpdatePlan(
    { remoteTargets: [], local: { machine: "space-mac", desktop: true, ios: false } },
    {
      ...testDependencies(createDryRunRunner([], (line) => lines.push(line))),
      env: { T3CODE_REPO: "/real/checkout" },
      pathExists: () => {
        throw new Error("dry-run must not inspect the filesystem");
      },
      inspectPlan: undefined,
      defensiveRevalidation: true,
    },
  );
  assert.equal(execution.results[0]?.stages[0]?.status, "OK");
  assert.isTrue(lines.some((line) => line.includes("(cwd: /synthetic/t3code)")));
  assert.isFalse(lines.some((line) => line.includes("/real/checkout")));
});

it("switches an approved local non-dev target before mutation", async () => {
  const requests: RunRequest[] = [];
  let branch = "main";
  const runner: CommandRunner = {
    dryRun: false,
    cancel: () => undefined,
    run: async (request) => {
      requests.push(request);
      if (request.command === "git" && request.args[0] === "switch") branch = "dev";
      if (request.command === "git" && request.args.includes("symbolic-ref")) {
        return { ...ok(), stdoutTail: `${branch}\n` };
      }
      return ok();
    },
  };
  const execution = await executePreparedUpdatePlan(
    {
      plan: {
        remoteTargets: [],
        local: { machine: "space-mac", desktop: true, ios: false },
      },
      decisions: [
        {
          approved: true,
          preflight: {
            target: "space-mac",
            local: true,
            checkout: "/repo",
            branch: "main",
            dirty: false,
            stage: { stage: "preflight", status: "OK" },
          },
        },
      ],
    },
    { ...testDependencies(runner), defensiveRevalidation: true },
  );
  assert.isTrue(requests.some((request) => request.args[0] === "switch"));
  assert.equal(resultExitCode(execution), 0);
});

it("blocks mutation when checkout state changes after preflight", async () => {
  const requests: RunRequest[] = [];
  const runner: CommandRunner = {
    dryRun: false,
    cancel: () => undefined,
    run: async (request) => {
      requests.push(request);
      if (request.command === "git" && request.args[0] === "status") {
        return { ...ok(), stdoutTail: "?? changed.txt\n" };
      }
      if (request.command === "git" && request.args.includes("symbolic-ref")) {
        return { ...ok(), stdoutTail: "dev\n" };
      }
      return ok();
    },
  };
  const execution = await executeUpdatePlan(
    { remoteTargets: [], local: { machine: "space-mac", desktop: true, ios: false } },
    { ...testDependencies(runner), defensiveRevalidation: true },
  );
  assert.isFalse(requests.some((request) => request.stage === "pull"));
  assert.deepStrictEqual(
    execution.results[0]?.stages.map(({ stage, status }) => [stage, status]),
    [
      ["preflight", "OK"],
      ["checkout", "OK"],
      ["preflight", "FAILED"],
      ["pull", "SKIPPED"],
      ["dependencies", "SKIPPED"],
      ["desktop", "SKIPPED"],
    ],
  );
});

it("reports cancellation during defensive revalidation as cancelled", async () => {
  const runner: CommandRunner = {
    dryRun: false,
    cancel: () => undefined,
    run: async (request) =>
      request.command === "git" && request.args[0] === "status"
        ? { ...ok(), exitCode: 130, cancelled: true }
        : { ...ok(), stdoutTail: "dev\n" },
  };
  const execution = await executeUpdatePlan(
    { remoteTargets: [], local: { machine: "space-mac", desktop: true, ios: false } },
    { ...testDependencies(runner), defensiveRevalidation: true },
  );
  assert.deepStrictEqual(
    execution.results[0]?.stages.map(({ stage, status }) => [stage, status]),
    [
      ["preflight", "OK"],
      ["checkout", "OK"],
      ["preflight", "CANCELLED"],
      ["pull", "CANCELLED"],
      ["dependencies", "CANCELLED"],
      ["desktop", "CANCELLED"],
    ],
  );
  assert.equal(resultExitCode(execution), 130);
});

it("exposes logs from defensive revalidation failures", async () => {
  const runner: CommandRunner = {
    dryRun: false,
    cancel: () => undefined,
    hasLog: () => true,
    run: async (request) =>
      request.command === "git" && request.args[0] === "status"
        ? { ...ok(), stdoutTail: "?? changed.txt\n" }
        : { ...ok(), stdoutTail: "dev\n" },
  };
  const execution = await executeUpdatePlan(
    { remoteTargets: [], local: { machine: "space-mac", desktop: true, ios: false } },
    {
      ...testDependencies(runner),
      defensiveRevalidation: true,
      logRoot: "/logs",
      runId: "test",
    },
  );
  assert.deepStrictEqual(failureLogPaths(execution.results), ["/logs/test/local-space-mac.log"]);
});

it("dry-run supports synthetic preflight failures", async () => {
  const execution = await executeUpdatePlan(
    { remoteTargets: ["grey-mac"] },
    {
      ...testDependencies(createDryRunRunner(parseSimulatedFailures(["grey-mac:preflight"]))),
      inspectPlan: undefined,
    },
  );
  assert.deepStrictEqual(
    execution.results[0]?.stages.map(({ stage, status }) => [stage, status]),
    [
      ["preflight", "FAILED"],
      ["checkout", "SKIPPED"],
      ["pull", "SKIPPED"],
      ["dependencies", "SKIPPED"],
      ["desktop", "SKIPPED"],
    ],
  );
});

it("dry-run is synthetic, invokes only its fake runner, and simulates all lanes", async () => {
  const lines: string[] = [];
  const requests: RunRequest[] = [];
  const suspensions: string[] = [];
  const terminal = fakeTerminal([]);
  const dryRunner = createDryRunRunner(
    parseSimulatedFailures(["grey-mac:pull", "space-mac:desktop"]),
    (line) => lines.push(line),
  );
  const runner: CommandRunner = {
    ...dryRunner,
    run: (request) => {
      requests.push(request);
      return dryRunner.run(request);
    },
  };
  const execution = await executeUpdatePlan(
    {
      remoteTargets: ["grey-mac"],
      local: { machine: "space-mac", desktop: true, ios: true },
    },
    {
      ...testDependencies(runner),
      input: terminal.input,
      output: terminal.output,
      progress: {
        start: () => undefined,
        stage: () => undefined,
        finish: () => undefined,
        suspend: () => suspensions.push("suspend"),
        resume: () => suspensions.push("resume"),
        close: () => undefined,
      },
    },
  );
  assert.isTrue(requests.every((request) => request.interactiveTerminal === undefined));
  assert.deepStrictEqual(suspensions, []);
  assert.deepStrictEqual(terminal.rawModes, []);
  assert.isTrue(lines.some((line) => line.startsWith("$ 'ssh'")));
  assert.isTrue(lines.some((line) => line.includes("install:desktop:dev")));
  assert.isTrue(lines.some((line) => line.includes("ios:local:release")));
  assert.deepStrictEqual(
    execution.results[0]?.stages.map(({ stage, status }) => [stage, status]),
    [
      ["preflight", "OK"],
      ["checkout", "OK"],
      ["pull", "FAILED"],
      ["dependencies", "SKIPPED"],
      ["desktop", "SKIPPED"],
    ],
  );
  assert.deepStrictEqual(
    execution.results[1]?.stages.map(({ stage, status }) => [stage, status]),
    [
      ["preflight", "OK"],
      ["checkout", "OK"],
      ["pull", "OK"],
      ["dependencies", "OK"],
      ["desktop", "FAILED"],
      ["ios", "OK"],
    ],
  );
  assert.deepStrictEqual(failureLogPaths(execution.results), []);
});
