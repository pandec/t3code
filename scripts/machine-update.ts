#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { collectSshConfigAliasesFromFile } from "@t3tools/ssh/config";
import * as Effect from "effect/Effect";

export const FLEET = ["space-mac", "grey-mac", "ubuntu-dell"] as const;
export type Machine = (typeof FLEET)[number];
export type UpdateStage =
  | "transport"
  | "preflight"
  | "checkout"
  | "pull"
  | "dependencies"
  | "desktop"
  | "ios"
  | "remote";

const REMOTE_STAGES = ["checkout", "pull", "dependencies", "desktop"] as const;
const PREP_STAGES = ["checkout", "pull", "dependencies"] as const;
const REMOTE_EXIT_CODES = {
  checkout: 41,
  pull: 42,
  dependencies: 43,
  desktop: 44,
} as const;
const REMOTE_PREFLIGHT_EXIT_CODE = 46;
const PREFLIGHT_MARKER = "__T3_PREFLIGHT_V1__";
const OUTPUT_TAIL_CHARS = 8_192;
const STAGE_MARKER_TAIL_CHARS = 64;

export interface CliOptions {
  readonly hosts: ReadonlyArray<string>;
  readonly includeLocalDesktop: boolean;
  readonly excludeLocalDesktop: boolean;
  readonly includeLocalIos: boolean;
  readonly excludeLocalIos: boolean;
  readonly localMachine?: string | undefined;
  readonly dryRun: boolean;
  readonly simulatedFailures: ReadonlyArray<string>;
  readonly showFailureLogs: boolean;
  readonly help: boolean;
  readonly explicitSelection: boolean;
}

export interface SimulatedFailure {
  readonly target: Machine;
  readonly stage: Exclude<UpdateStage, "remote">;
}

export interface PreflightResult {
  readonly target: Machine;
  readonly local: boolean;
  readonly checkout?: string | undefined;
  readonly branch?: string | undefined;
  readonly dirty?: boolean | undefined;
  readonly stage: StageResult;
  readonly logPath?: string | undefined;
  readonly hasLog?: boolean | undefined;
}

export interface PreflightDecision {
  readonly preflight: PreflightResult;
  readonly approved: boolean;
  readonly skipDetail?: string | undefined;
}

export interface SelectorState {
  readonly cursor: number;
  readonly selected: ReadonlySet<number>;
}

export type SelectorKey = "up" | "down" | "toggle" | "confirm" | "cancel" | "interrupt" | "ignore";

export interface SelectionChoice {
  readonly id: string;
  readonly target: Machine;
  readonly kind: "remote-desktop" | "local-desktop" | "local-ios";
  readonly label: string;
}

export interface RunRequest {
  readonly target: Machine;
  readonly stage: UpdateStage;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly logPath?: string | undefined;
  readonly interactiveTerminal?: boolean | undefined;
  readonly onOutput?: ((chunk: string) => void) | undefined;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly cancelled: boolean;
  readonly error?: string | undefined;
}

export interface CommandRunner {
  readonly dryRun: boolean;
  readonly run: (request: RunRequest) => Promise<CommandResult>;
  readonly cancel: (force?: boolean) => void;
  readonly hasLog?: (path: string) => boolean;
  readonly simulatedFailure?: (target: Machine, stage: Exclude<UpdateStage, "remote">) => boolean;
}

export type StageStatus = "OK" | "FAILED" | "SKIPPED" | "CANCELLED";

export interface StageResult {
  readonly stage: UpdateStage;
  readonly status: StageStatus;
  readonly detail?: string | undefined;
  readonly tail?: string | undefined;
}

export interface TargetResult {
  readonly target: Machine;
  readonly label: string;
  readonly stages: ReadonlyArray<StageResult>;
  readonly logPath?: string | undefined;
  readonly hasLog?: boolean | undefined;
}

export interface LocalUpdatePlan {
  readonly machine: Machine;
  readonly desktop: boolean;
  readonly ios: boolean;
}

export interface UpdatePlan {
  readonly remoteTargets: ReadonlyArray<Machine>;
  readonly local?: LocalUpdatePlan | undefined;
}

export interface ProgressReporter {
  readonly start: (jobId: string, label: string, stage: string) => void;
  readonly stage: (jobId: string, stage: string) => void;
  readonly finish: (jobId: string, status: "OK" | "FAILED" | "SKIPPED" | "CANCELLED") => void;
  readonly suspend: () => void;
  readonly resume: () => void;
  readonly close: () => void;
}

export interface UpdateDependencies {
  readonly runner: CommandRunner;
  readonly homeDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly pathExists: (path: string) => boolean;
  readonly log: (line: string) => void;
  readonly progress?: ProgressReporter | undefined;
  readonly logRoot?: string | undefined;
  readonly runId?: string | undefined;
  readonly input?: TerminalInput | undefined;
  readonly output?: TerminalOutput | undefined;
  readonly inspectPlan?:
    | ((
        plan: UpdatePlan,
        dependencies: UpdateDependencies,
      ) => Promise<ReadonlyArray<PreflightResult>>)
    | undefined;
  readonly defensiveRevalidation?: boolean | undefined;
}

export interface ExecutionResult {
  readonly results: ReadonlyArray<TargetResult>;
  readonly cancelled: boolean;
}

export interface PreparedUpdatePlan {
  readonly plan: UpdatePlan;
  readonly decisions: ReadonlyArray<PreflightDecision>;
}

export interface TerminalInput {
  readonly isTTY?: boolean | undefined;
  readonly setRawMode?: ((mode: boolean) => void) | undefined;
  readonly resume: () => void;
  readonly pause: () => void;
  readonly on: (event: "data", listener: (data: Buffer) => void) => void;
  readonly off: (event: "data", listener: (data: Buffer) => void) => void;
}

export interface TerminalOutput {
  readonly isTTY?: boolean | undefined;
  readonly write: (value: string) => void;
}

export class MachineUpdateError extends Error {
  readonly exitCode: 2 | 130;

  constructor(message: string, exitCode: 2 | 130 = 2) {
    super(message);
    this.name = "MachineUpdateError";
    this.exitCode = exitCode;
  }
}

export class CancellationController {
  private listeners = new Set<() => void>();
  cancelled = false;

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const listener of this.listeners) listener();
  }

  onCancel(listener: () => void): () => void {
    if (this.cancelled) {
      listener();
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function normalizeHostname(hostname: string): string {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/\.local$/u, "");
  return normalized.replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
}

export function resolveLocalMachine(
  hostname: string,
  override?: string,
  fallbackHostnames: ReadonlyArray<string> = [],
): Machine {
  const aliases: Readonly<Record<string, Machine>> = {
    spacemac: "space-mac",
    "space-mac": "space-mac",
    greymac: "grey-mac",
    "grey-mac": "grey-mac",
    "ubuntu-dell": "ubuntu-dell",
    ubuntudell: "ubuntu-dell",
  };
  const candidates = override === undefined ? [hostname, ...fallbackHostnames] : [override];
  for (const candidate of candidates) {
    const normalized = normalizeHostname(candidate);
    const machine = Object.hasOwn(aliases, normalized) ? aliases[normalized] : undefined;
    if (machine !== undefined) return machine;
  }
  throw new MachineUpdateError(
    `Unknown local machine "${override ?? hostname}". Use --local-machine ${FLEET.join("|")} to override.`,
  );
}

function readMacLocalHostname(): string | undefined {
  const result = NodeChildProcess.spawnSync("/usr/sbin/scutil", ["--get", "LocalHostName"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const hostname = result.status === 0 ? result.stdout.trim() : "";
  return hostname.length > 0 ? hostname : undefined;
}

export function getEligibleRemoteTargets(
  localMachine: Machine,
  sshAliases: ReadonlyArray<string>,
): ReadonlyArray<Machine> {
  const aliases = new Set(sshAliases);
  return FLEET.filter((machine) => machine !== localMachine && aliases.has(machine));
}

function readFlagValue(args: ReadonlyArray<string>, index: number, name: string): [string, number] {
  const arg = args[index]!;
  const equalsPrefix = `${name}=`;
  if (arg.startsWith(equalsPrefix)) {
    const value = arg.slice(equalsPrefix.length);
    if (value.length === 0) throw new MachineUpdateError(`${name} requires a value.`);
    return [value, index];
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new MachineUpdateError(`${name} requires a value.`);
  }
  return [value, index + 1];
}

export function parseCliArgs(args: ReadonlyArray<string>): CliOptions {
  const hosts: string[] = [];
  const simulatedFailures: string[] = [];
  let includeLocalDesktop = false;
  let excludeLocalDesktop = false;
  let includeLocalIos = false;
  let excludeLocalIos = false;
  let localMachine: string | undefined;
  let dryRun = false;
  let showFailureLogs = false;
  let help = false;
  let explicitSelection = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--" && index === 0) continue;
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--include-local-desktop") {
      includeLocalDesktop = true;
      explicitSelection = true;
    } else if (arg === "--no-local-desktop") {
      excludeLocalDesktop = true;
      explicitSelection = true;
    } else if (arg === "--include-local-ios") {
      includeLocalIos = true;
      explicitSelection = true;
    } else if (arg === "--no-local-ios") {
      excludeLocalIos = true;
      explicitSelection = true;
    } else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--show-failure-logs") showFailureLogs = true;
    else if (arg === "--host" || arg.startsWith("--host=")) {
      const [value, nextIndex] = readFlagValue(args, index, "--host");
      hosts.push(value);
      explicitSelection = true;
      index = nextIndex;
    } else if (arg === "--local-machine" || arg.startsWith("--local-machine=")) {
      [localMachine, index] = readFlagValue(args, index, "--local-machine");
    } else if (arg === "--fail" || arg.startsWith("--fail=")) {
      const [value, nextIndex] = readFlagValue(args, index, "--fail");
      simulatedFailures.push(value);
      index = nextIndex;
    } else throw new MachineUpdateError(`Unknown option "${arg}".`);
  }

  if (includeLocalDesktop && excludeLocalDesktop) {
    throw new MachineUpdateError(
      "--include-local-desktop and --no-local-desktop cannot be combined.",
    );
  }
  if (includeLocalIos && excludeLocalIos) {
    throw new MachineUpdateError("--include-local-ios and --no-local-ios cannot be combined.");
  }
  if (simulatedFailures.length > 0 && !dryRun) {
    throw new MachineUpdateError("--fail may only be used with --dry-run.");
  }

  return {
    hosts,
    includeLocalDesktop,
    excludeLocalDesktop,
    includeLocalIos,
    excludeLocalIos,
    localMachine,
    dryRun,
    simulatedFailures,
    showFailureLogs,
    help,
    explicitSelection,
  };
}

export function parseSimulatedFailures(
  values: ReadonlyArray<string>,
): ReadonlyArray<SimulatedFailure> {
  const stages = new Set<Exclude<UpdateStage, "remote">>([
    "transport",
    "preflight",
    "checkout",
    "pull",
    "dependencies",
    "desktop",
    "ios",
  ]);
  return values.map((value) => {
    const match = /^([^:]+):([^:]+)$/u.exec(value);
    const target = match?.[1];
    const stage = match?.[2];
    if (
      !target ||
      !stage ||
      !FLEET.includes(target as Machine) ||
      !stages.has(stage as Exclude<UpdateStage, "remote">)
    ) {
      throw new MachineUpdateError(
        `Invalid --fail "${value}". Expected <${FLEET.join("|")}>:<transport|preflight|checkout|pull|dependencies|desktop|ios>.`,
      );
    }
    return { target: target as Machine, stage: stage as Exclude<UpdateStage, "remote"> };
  });
}

export function validateSimulatedFailures(
  failures: ReadonlyArray<SimulatedFailure>,
  plan: UpdatePlan,
): void {
  const remoteTargets = new Set(plan.remoteTargets);
  for (const failure of failures) {
    if (remoteTargets.has(failure.target)) {
      if (failure.stage === "ios") {
        throw new MachineUpdateError(
          `Invalid --fail "${failure.target}:${failure.stage}": remote targets do not run iOS installs.`,
        );
      }
      continue;
    }
    if (plan.local?.machine === failure.target) {
      if (failure.stage === "transport") {
        throw new MachineUpdateError(
          `Invalid --fail "${failure.target}:${failure.stage}": the local target has no SSH transport.`,
        );
      }
      if (failure.stage === "desktop" && !plan.local.desktop) {
        throw new MachineUpdateError(
          `Invalid --fail "${failure.target}:${failure.stage}": local desktop is not selected.`,
        );
      }
      if (failure.stage === "ios" && !plan.local.ios) {
        throw new MachineUpdateError(
          `Invalid --fail "${failure.target}:${failure.stage}": local iOS is not selected.`,
        );
      }
      continue;
    }
    throw new MachineUpdateError(
      `Invalid --fail "${failure.target}:${failure.stage}": the target is not selected.`,
    );
  }
}

export function selectorKey(data: Buffer | string): SelectorKey {
  const value = typeof data === "string" ? data : data.toString("utf8");
  if (value === "") return "interrupt";
  if (value === "" || value.toLowerCase() === "q") return "cancel";
  if (value === "[A") return "up";
  if (value === "[B") return "down";
  if (value === " ") return "toggle";
  if (value === "\r" || value === "\n") return "confirm";
  return "ignore";
}

export function reduceSelector(
  state: SelectorState,
  key: SelectorKey,
  itemCount: number,
): SelectorState {
  if (itemCount === 0) return state;
  if (key === "up" || key === "down") {
    const delta = key === "up" ? -1 : 1;
    return { ...state, cursor: (state.cursor + delta + itemCount) % itemCount };
  }
  if (key === "toggle") {
    const selected = new Set(state.selected);
    if (selected.has(state.cursor)) selected.delete(state.cursor);
    else selected.add(state.cursor);
    return { ...state, selected };
  }
  return state;
}

function runRawPrompt<T>(
  input: TerminalInput,
  output: TerminalOutput,
  render: () => string,
  handle: (key: SelectorKey, raw: string) => T | undefined,
  cancelResult?: T,
  cancellation?: CancellationController,
): Promise<T> {
  if (!input.isTTY || !output.isTTY || input.setRawMode === undefined) {
    return Promise.reject(new MachineUpdateError("Interactive selection requires a TTY."));
  }

  const setRawMode = input.setRawMode.bind(input);
  return new Promise<T>((resolve, reject) => {
    let renderedLines = 0;
    let rendered = false;
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    const redraw = () => {
      if (renderedLines > 0) output.write(`[${String(renderedLines)}A[J`);
      else if (rendered) output.write("\r[2K");
      const view = render();
      output.write(view);
      renderedLines = view.split("\n").length - 1;
      rendered = true;
    };
    const cleanup = () => {
      input.off("data", onData);
      unsubscribe();
      setRawMode(false);
      input.pause();
      output.write("[?25h");
    };
    const cancel = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new MachineUpdateError("Cancelled.", 130));
    };
    const onData = (data: Buffer) => {
      const raw = data.toString("utf8");
      const key = selectorKey(raw);
      if (key === "interrupt" || key === "cancel") {
        if (key === "cancel" && cancelResult !== undefined) {
          settled = true;
          cleanup();
          output.write("\n");
          resolve(cancelResult);
        } else cancel();
        return;
      }
      const result = handle(key, raw);
      if (result !== undefined) {
        settled = true;
        cleanup();
        output.write("\n");
        resolve(result);
      } else redraw();
    };

    output.write("[?25l");
    setRawMode(true);
    input.resume();
    input.on("data", onData);
    unsubscribe = cancellation?.onCancel(cancel) ?? (() => undefined);
    if (!settled) redraw();
  });
}

export function buildSelectionChoices(
  remoteTargets: ReadonlyArray<Machine>,
  localMachine: Machine,
  platform: NodeJS.Platform,
): ReadonlyArray<SelectionChoice> {
  return [
    ...remoteTargets.map(
      (target): SelectionChoice => ({
        id: `remote:${target}`,
        target,
        kind: "remote-desktop",
        label: `${target} desktop (remote)`,
      }),
    ),
    {
      id: "local:desktop",
      target: localMachine,
      kind: "local-desktop",
      label: `${localMachine} desktop (local)`,
    } satisfies SelectionChoice,
    ...(platform === "darwin"
      ? [
          {
            id: "local:ios",
            target: localMachine,
            kind: "local-ios",
            label: `${localMachine} iOS (local)`,
          } satisfies SelectionChoice,
        ]
      : []),
  ];
}

export function planFromChoices(
  choices: ReadonlyArray<SelectionChoice>,
  selectedIds: ReadonlySet<string>,
): UpdatePlan {
  const selected = choices.filter((choice) => selectedIds.has(choice.id));
  const remoteTargets = selected
    .filter((choice) => choice.kind === "remote-desktop")
    .map((choice) => choice.target);
  const localDesktop = selected.some((choice) => choice.kind === "local-desktop");
  const localIos = selected.some((choice) => choice.kind === "local-ios");
  const localChoice = selected.find((choice) => choice.kind !== "remote-desktop");
  return {
    remoteTargets,
    ...(localChoice
      ? { local: { machine: localChoice.target, desktop: localDesktop, ios: localIos } }
      : {}),
  };
}

export async function selectUpdatePlan(
  choices: ReadonlyArray<SelectionChoice>,
  input: TerminalInput = process.stdin,
  output: TerminalOutput = process.stdout,
): Promise<UpdatePlan> {
  let state: SelectorState = { cursor: 0, selected: new Set() };
  const selectedIds = await runRawPrompt(
    input,
    output,
    () => {
      const rows = choices.map((choice, index) => {
        const pointer = index === state.cursor ? ">" : " ";
        const selected = state.selected.has(index) ? "[x]" : "[ ]";
        return `${pointer} ${selected} ${choice.label}`;
      });
      return [`Select updates (Space toggles, Enter confirms):`, ...rows].join("\n") + "\n";
    },
    (key) => {
      if (key === "confirm") {
        return new Set(
          choices.filter((_, index) => state.selected.has(index)).map((choice) => choice.id),
        );
      }
      state = reduceSelector(state, key, choices.length);
      return undefined;
    },
  );
  return planFromChoices(choices, selectedIds);
}

export function createExplicitPlan(
  options: CliOptions,
  localMachine: Machine,
  platform: NodeJS.Platform,
  eligibleTargets: ReadonlyArray<Machine>,
): UpdatePlan {
  const remoteTargets = validateSelectedHosts(options.hosts, eligibleTargets);
  if (options.includeLocalIos && platform !== "darwin") {
    throw new MachineUpdateError("--include-local-ios is only available on macOS.");
  }
  const desktop = options.includeLocalDesktop;
  const ios = options.includeLocalIos;
  return {
    remoteTargets,
    ...(desktop || ios ? { local: { machine: localMachine, desktop, ios } } : {}),
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function remoteCheckoutScript(): ReadonlyArray<string> {
  return [
    'repo=""',
    'if [[ -n "${T3CODE_REPO:-}" && -e "$T3CODE_REPO/.git" ]]; then',
    '  repo="$T3CODE_REPO"',
    'elif [[ -e "$HOME/SynologyDrive/AIMac/repos/t3code/.git" ]]; then',
    '  repo="$HOME/SynologyDrive/AIMac/repos/t3code"',
    "elif command -v zoxide >/dev/null 2>&1; then",
    '  repo="$(zoxide query t3code 2>/dev/null || true)"',
    "fi",
    '[[ -n "$repo" && -e "$repo/.git" ]] || { printf "T3 Code checkout not found.\\n" >&2; exit 41; }',
    'cd "$repo" || exit 41',
  ];
}

export function buildRemotePreflightScript(): string {
  return [
    "set -u",
    ...remoteCheckoutScript(),
    'branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null)"',
    "branch_status=$?",
    'if [[ "$branch_status" -eq 1 ]]; then branch="DETACHED"; elif [[ "$branch_status" -ne 0 ]]; then exit 46; fi',
    'dirty="$(git status --porcelain=v1 --untracked-files=all 2>/dev/null)" || exit 46',
    `printf '\\0${PREFLIGHT_MARKER}\\0%s\\0%s\\0%s\\0' "$repo" "$branch" "$([[ -n "$dirty" ]] && printf 1 || printf 0)"`,
  ].join("\n");
}

export function buildRemoteScript(checkout?: string, expectedBranch = "dev"): string {
  return [
    "set -u",
    'printf "__T3_STAGE__ checkout\\n"',
    ...(checkout
      ? [`repo=${shellQuote(checkout)}`, 'cd "$repo" || exit 41']
      : remoteCheckoutScript()),
    `expected=${shellQuote(expectedBranch)}`,
    'branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null)"',
    "branch_status=$?",
    'if [[ "$branch_status" -eq 1 ]]; then branch="DETACHED"; elif [[ "$branch_status" -ne 0 ]]; then exit 46; fi',
    'git_state="$(git status --porcelain=v1 --untracked-files=all)" || exit 46',
    '[[ -z "$git_state" && "$branch" == "$expected" ]] || { printf "Checkout changed after preflight.\\n" >&2; exit 46; }',
    'if [[ "$branch" != dev ]]; then',
    "  git switch dev || exit 46",
    '  branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null)" || exit 46',
    '  git_state="$(git status --porcelain=v1 --untracked-files=all)" || exit 46',
    '  [[ "$branch" == dev && -z "$git_state" ]] || { printf "Expected clean dev checkout.\\n" >&2; exit 46; }',
    "fi",
    'printf "checkout: %s\\n" "$repo"',
    'printf "__T3_STAGE__ pull\\n"',
    "git pull --ff-only || exit 42",
    'printf "__T3_STAGE__ dependencies\\n"',
    "pnpm install || exit 43",
    'printf "__T3_STAGE__ desktop\\n"',
    "pnpm run install:desktop:dev || exit 44",
  ].join("\n");
}

export function buildRemotePreflightCommand(target: Machine): RunRequest {
  return {
    target,
    stage: "preflight",
    command: "ssh",
    args: [
      "-n",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      target,
      "zsh",
      "-lc",
      shellQuote(buildRemotePreflightScript()),
    ],
  };
}

export function buildRemoteCommand(
  target: Machine,
  logPath?: string,
  checkout?: string,
  expectedBranch = "dev",
): RunRequest {
  return {
    target,
    stage: "remote",
    command: "ssh",
    args: [
      "-n",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      target,
      "zsh",
      "-lc",
      shellQuote(buildRemoteScript(checkout, expectedBranch)),
    ],
    logPath,
  };
}

export function classifyRemoteExit(exitCode: number): UpdateStage | undefined {
  if (exitCode === 0) return undefined;
  if (exitCode === 255) return "transport";
  if (exitCode === REMOTE_PREFLIGHT_EXIT_CODE) return "preflight";
  for (const stage of REMOTE_STAGES) {
    if (REMOTE_EXIT_CODES[stage] === exitCode) return stage;
  }
  return "remote";
}

function resultTail(result: CommandResult): string | undefined {
  const combined = [result.stderrTail.trim(), result.stdoutTail.trim()].filter(Boolean).join("\n");
  return combined || result.error;
}

function remoteResults(result: CommandResult): ReadonlyArray<StageResult> {
  if (result.cancelled) return [{ stage: "remote", status: "CANCELLED" }];
  const failure = classifyRemoteExit(result.exitCode);
  if (failure === undefined) return REMOTE_STAGES.map((stage) => ({ stage, status: "OK" }));
  if (failure === "transport" || failure === "preflight" || failure === "remote") {
    return [
      {
        stage: failure,
        status: "FAILED",
        detail: result.error ?? `exit ${String(result.exitCode)}`,
        tail: resultTail(result),
      },
      ...REMOTE_STAGES.map((stage): StageResult => ({ stage, status: "SKIPPED" })),
    ];
  }
  const failedIndex = REMOTE_STAGES.indexOf(failure as (typeof REMOTE_STAGES)[number]);
  return REMOTE_STAGES.map(
    (stage, index): StageResult => ({
      stage,
      status: index < failedIndex ? "OK" : index === failedIndex ? "FAILED" : "SKIPPED",
      detail: index === failedIndex ? `exit ${String(result.exitCode)}` : undefined,
      tail: index === failedIndex ? resultTail(result) : undefined,
    }),
  );
}

function appendTail(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return next.length <= OUTPUT_TAIL_CHARS ? next : next.slice(-OUTPUT_TAIL_CHARS);
}

function terminateChild(
  child: NodeChildProcess.ChildProcess,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform,
): void {
  if (child.pid === undefined) return;
  try {
    if (platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process already exited.
    }
  }
}

export function createRealRunner(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): CommandRunner {
  const children = new Set<NodeChildProcess.ChildProcess>();
  let cancelled = false;
  let escalationTimer: NodeJS.Timeout | undefined;

  const killChildren = (signal: NodeJS.Signals) => {
    for (const child of children) terminateChild(child, signal, platform);
  };
  const cancel = (force = false) => {
    if (force) {
      cancelled = true;
      if (escalationTimer !== undefined) clearTimeout(escalationTimer);
      killChildren("SIGKILL");
      return;
    }
    if (cancelled) return;
    cancelled = true;
    killChildren("SIGTERM");
    escalationTimer = setTimeout(() => killChildren("SIGKILL"), 2_000);
    escalationTimer.unref();
  };

  return {
    dryRun: false,
    cancel,
    hasLog: NodeFS.existsSync,
    run: (request) =>
      new Promise<CommandResult>((resolve) => {
        if (cancelled) {
          resolve({ exitCode: 130, stdoutTail: "", stderrTail: "", cancelled: true });
          return;
        }
        let stdoutTail = "";
        let stderrTail = "";
        let settled = false;
        let spawnError: string | undefined;
        let logStream: NodeFS.WriteStream | undefined;
        if (request.logPath) {
          try {
            NodeFS.mkdirSync(NodePath.dirname(request.logPath), { recursive: true, mode: 0o700 });
            const fd = NodeFS.openSync(
              request.logPath,
              NodeFS.constants.O_WRONLY |
                NodeFS.constants.O_CREAT |
                NodeFS.constants.O_APPEND |
                NodeFS.constants.O_NOFOLLOW,
              0o600,
            );
            logStream = NodeFS.createWriteStream(request.logPath, { fd, autoClose: true });
            logStream.on("error", () => undefined);
            logStream.write(
              `\n$ ${[request.command, ...request.args].map(shellQuote).join(" ")}${request.cwd ? ` (cwd: ${request.cwd})` : ""}\n`,
            );
          } catch {
            // Updating should continue even when failure logging is unavailable.
          }
        }
        const child = NodeChildProcess.spawn(request.command, request.args, {
          cwd: request.cwd,
          env,
          detached: platform !== "win32",
          stdio: request.interactiveTerminal
            ? ["inherit", "inherit", "inherit"]
            : ["ignore", "pipe", "pipe"],
        });
        children.add(child);
        child.stdout?.on("data", (chunk: Buffer) => {
          stdoutTail = appendTail(stdoutTail, chunk);
          if (logStream && !logStream.write(chunk)) {
            child.stdout?.pause();
            logStream.once("drain", () => child.stdout?.resume());
          }
          request.onOutput?.(chunk.toString("utf8"));
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderrTail = appendTail(stderrTail, chunk);
          if (logStream && !logStream.write(chunk)) {
            child.stderr?.pause();
            logStream.once("drain", () => child.stderr?.resume());
          }
        });
        child.once("error", (error) => {
          spawnError = error.message;
          stderrTail = appendTail(stderrTail, Buffer.from(`${error.message}\n`));
          logStream?.write(`${error.message}\n`);
        });
        child.once("close", (code) => {
          if (settled) return;
          settled = true;
          children.delete(child);
          if (children.size === 0 && escalationTimer !== undefined) {
            clearTimeout(escalationTimer);
            escalationTimer = undefined;
          }
          const wasCancelled = cancelled;
          const finish = () =>
            resolve({
              exitCode: wasCancelled ? 130 : (code ?? 1),
              stdoutTail,
              stderrTail,
              cancelled: wasCancelled,
              error: spawnError,
            });
          if (logStream) logStream.end(finish);
          else finish();
        });
      }),
  };
}

function failureCode(stage: Exclude<UpdateStage, "remote">): number {
  if (stage === "transport") return 255;
  if (stage === "preflight") return 46;
  if (stage === "ios") return 45;
  return REMOTE_EXIT_CODES[stage];
}

export function createDryRunRunner(
  failures: ReadonlyArray<SimulatedFailure>,
  log: (line: string) => void = console.log,
): CommandRunner {
  const simulatedFailure = (target: Machine, stage: Exclude<UpdateStage, "remote">): boolean =>
    failures.some((failure) => failure.target === target && failure.stage === stage);
  let cancelled = false;
  return {
    dryRun: true,
    simulatedFailure,
    cancel: () => {
      cancelled = true;
    },
    run: async (request) => {
      const cwd = request.cwd === undefined ? "" : ` (cwd: ${request.cwd})`;
      log(`$ ${[request.command, ...request.args].map(shellQuote).join(" ")}${cwd}`);
      if (cancelled) {
        return { exitCode: 130, stdoutTail: "", stderrTail: "", cancelled: true };
      }
      if (request.stage === "preflight" && request.command === "ssh") {
        const failure = failures.find(
          (candidate) => candidate.target === request.target && candidate.stage === "preflight",
        );
        return {
          exitCode: failure === undefined ? 0 : failureCode(failure.stage),
          stdoutTail:
            failure === undefined
              ? ["", PREFLIGHT_MARKER, "/synthetic/t3code", "dev", "0", ""].join("\0")
              : "",
          stderrTail: failure === undefined ? "" : "Simulated preflight failure.",
          cancelled: false,
        };
      }
      if (request.stage !== "remote") {
        const failure = failures.find(
          (candidate) => candidate.target === request.target && candidate.stage === request.stage,
        );
        const syntheticStdout =
          request.command === "zoxide"
            ? "/synthetic/t3code\n"
            : request.command === "git" && request.args.includes("symbolic-ref")
              ? "dev\n"
              : "";
        return {
          exitCode: failure === undefined ? 0 : failureCode(failure.stage),
          stdoutTail: failure === undefined ? syntheticStdout : "",
          stderrTail: failure === undefined ? "" : `Simulated ${failure.stage} failure.`,
          cancelled: false,
        };
      }
      const candidates = failures.filter(
        (candidate) => candidate.target === request.target && candidate.stage !== "ios",
      );
      const order = (failure: SimulatedFailure): number => {
        if (failure.stage === "transport") return -1;
        return REMOTE_STAGES.indexOf(failure.stage as (typeof REMOTE_STAGES)[number]);
      };
      const failure = candidates.reduce<SimulatedFailure | undefined>(
        (earliest, candidate) =>
          earliest === undefined || order(candidate) < order(earliest) ? candidate : earliest,
        undefined,
      );
      return {
        exitCode: failure === undefined ? 0 : failureCode(failure.stage),
        stdoutTail: "",
        stderrTail: failure === undefined ? "" : `Simulated ${failure.stage} failure.`,
        cancelled: false,
      };
    },
  };
}

function commandFailure(stage: UpdateStage, result: CommandResult): StageResult {
  return result.cancelled
    ? { stage, status: "CANCELLED" }
    : {
        stage,
        status: "FAILED",
        detail: result.error ?? `exit ${String(result.exitCode)}`,
        tail: resultTail(result),
      };
}

async function resolveLocalCheckout(
  dependencies: UpdateDependencies,
  target: Machine,
  logPath: string | undefined,
): Promise<{ readonly checkout?: string; readonly result: StageResult }> {
  if (dependencies.runner.simulatedFailure?.(target, "checkout")) {
    const simulated = await dependencies.runner.run({
      target,
      stage: "checkout",
      command: "zoxide",
      args: ["query", "t3code"],
      logPath,
    });
    return { result: commandFailure("checkout", simulated) };
  }
  if (dependencies.runner.dryRun) {
    return {
      checkout: "/synthetic/t3code",
      result: { stage: "checkout", status: "OK" },
    };
  }
  const candidates = [
    dependencies.env.T3CODE_REPO,
    NodePath.join(dependencies.homeDir, "SynologyDrive", "AIMac", "repos", "t3code"),
  ];
  for (const candidate of candidates) {
    if (candidate && dependencies.pathExists(NodePath.join(candidate, ".git"))) {
      return { checkout: NodePath.resolve(candidate), result: { stage: "checkout", status: "OK" } };
    }
  }

  const result = await dependencies.runner.run({
    target,
    stage: "checkout",
    command: "zoxide",
    args: ["query", "t3code"],
    logPath,
  });
  const checkout = result.stdoutTail.trim();
  if (
    result.exitCode === 0 &&
    checkout.length > 0 &&
    (dependencies.runner.dryRun || dependencies.pathExists(NodePath.join(checkout, ".git")))
  ) {
    return { checkout: NodePath.resolve(checkout), result: { stage: "checkout", status: "OK" } };
  }
  const failed = commandFailure("checkout", result);
  return {
    result:
      result.exitCode === 0 && !result.cancelled
        ? {
            ...failed,
            detail:
              "T3 Code checkout not found via T3CODE_REPO, standard path, or zoxide query t3code.",
          }
        : failed,
  };
}

async function inspectLocalCheckout(
  target: Machine,
  dependencies: UpdateDependencies,
): Promise<PreflightResult> {
  const logPath = jobLogPath(dependencies, `local-${target}`);
  const checkoutResult = await resolveLocalCheckout(dependencies, target, logPath);
  if (checkoutResult.result.status !== "OK" || checkoutResult.checkout === undefined) {
    return {
      target,
      local: true,
      stage: commandFailure("preflight", {
        exitCode: 46,
        stdoutTail: "",
        stderrTail:
          checkoutResult.result.detail ?? checkoutResult.result.tail ?? "Checkout unavailable.",
        cancelled: checkoutResult.result.status === "CANCELLED",
      }),
      logPath,
      hasLog: logPath !== undefined && (dependencies.runner.hasLog?.(logPath) ?? false),
    };
  }
  const checkout = checkoutResult.checkout;
  const branchResult = await dependencies.runner.run({
    target,
    stage: "preflight",
    command: "git",
    args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
    cwd: checkout,
    logPath,
  });
  if (branchResult.cancelled || (branchResult.exitCode !== 0 && branchResult.exitCode !== 1)) {
    return {
      target,
      local: true,
      checkout,
      stage: commandFailure("preflight", branchResult),
      logPath,
      hasLog: logPath !== undefined && (dependencies.runner.hasLog?.(logPath) ?? false),
    };
  }
  const branch = branchResult.exitCode === 0 ? branchResult.stdoutTail.trim() : "DETACHED";
  const statusResult = await dependencies.runner.run({
    target,
    stage: "preflight",
    command: "git",
    args: ["status", "--porcelain=v1", "--untracked-files=all"],
    cwd: checkout,
    logPath,
  });
  if (statusResult.exitCode !== 0 || statusResult.cancelled) {
    return {
      target,
      local: true,
      checkout,
      branch,
      stage: commandFailure("preflight", statusResult),
      logPath,
      hasLog: logPath !== undefined && (dependencies.runner.hasLog?.(logPath) ?? false),
    };
  }
  const dirty = statusResult.stdoutTail.length > 0;
  return {
    target,
    local: true,
    checkout,
    branch,
    dirty,
    stage: dirty
      ? { stage: "preflight", status: "FAILED", detail: "checkout is dirty" }
      : { stage: "preflight", status: "OK", detail: branch },
    logPath,
    hasLog: logPath !== undefined && (dependencies.runner.hasLog?.(logPath) ?? false),
  };
}

function parseRemotePreflight(target: Machine, result: CommandResult): PreflightResult {
  if (result.exitCode !== 0 || result.cancelled) {
    const stage = result.exitCode === 255 && !result.cancelled ? "transport" : "preflight";
    return { target, local: false, stage: commandFailure(stage, result) };
  }
  const marker = `\0${PREFLIGHT_MARKER}\0`;
  const markerIndex = result.stdoutTail.lastIndexOf(marker);
  const fields =
    markerIndex < 0 ? [] : result.stdoutTail.slice(markerIndex + marker.length).split("\0");
  const checkout = fields[0];
  const branch = fields[1];
  const dirtyValue = fields[2];
  if (markerIndex < 0 || !checkout || !branch || (dirtyValue !== "0" && dirtyValue !== "1")) {
    return {
      target,
      local: false,
      stage: { stage: "preflight", status: "FAILED", detail: "invalid preflight response" },
    };
  }
  const dirty = dirtyValue === "1";
  return {
    target,
    local: false,
    checkout,
    branch,
    dirty,
    stage: dirty
      ? { stage: "preflight", status: "FAILED", detail: "checkout is dirty" }
      : { stage: "preflight", status: "OK", detail: branch },
  };
}

async function inspectRemoteCheckout(
  target: Machine,
  dependencies: UpdateDependencies,
): Promise<PreflightResult> {
  const logPath = jobLogPath(dependencies, `remote-${target}`);
  const parsed = parseRemotePreflight(
    target,
    await dependencies.runner.run({ ...buildRemotePreflightCommand(target), logPath }),
  );
  return {
    ...parsed,
    logPath,
    hasLog: logPath !== undefined && (dependencies.runner.hasLog?.(logPath) ?? false),
  };
}

export async function preflightUpdatePlan(
  plan: UpdatePlan,
  dependencies: UpdateDependencies,
): Promise<ReadonlyArray<PreflightResult>> {
  const inspections: Array<Promise<PreflightResult>> = plan.remoteTargets.map((target) =>
    inspectRemoteCheckout(target, dependencies),
  );
  if (plan.local) inspections.push(inspectLocalCheckout(plan.local.machine, dependencies));
  return Promise.all(inspections);
}

function hasInteractiveTerminal(input: TerminalInput, output: TerminalOutput): boolean {
  return input.isTTY === true && output.isTTY === true && input.setRawMode !== undefined;
}

function selectedTargetLabel(plan: UpdatePlan, target: Machine): string {
  const local = plan.local?.machine === target ? plan.local : undefined;
  const surfaces = local
    ? [local.desktop ? "desktop" : "", local.ios ? "iOS" : ""].filter(Boolean).join(" + ")
    : "desktop";
  return `${target} ${surfaces}`;
}

function preflightIssueDetail(preflight: PreflightResult): string {
  return preflight.stage.detail ?? preflight.stage.status.toLowerCase();
}

function reportPreflightIssues(
  plan: UpdatePlan,
  preflights: ReadonlyArray<PreflightResult>,
  interactive: boolean,
  log: (line: string) => void,
): void {
  const issues = preflights.flatMap((preflight): ReadonlyArray<string> => {
    const label = selectedTargetLabel(plan, preflight.target);
    if (preflight.stage.status !== "OK") {
      return [`  BLOCKED ${label} — ${preflightIssueDetail(preflight)}`];
    }
    if (preflight.branch !== "dev") {
      const branch = preflight.branch ?? "unknown";
      return interactive
        ? [`  SWITCH  ${label} — ${branch} → dev`]
        : [`  SKIP    ${label} — ${branch} (non-dev, non-TTY)`];
    }
    return [];
  });
  if (issues.length === 0) return;
  log("\nPreflight issues");
  for (const issue of issues) log(issue);
}

export async function selectBranchSwitches(
  preflights: ReadonlyArray<PreflightResult>,
  input: TerminalInput,
  output: TerminalOutput,
  cancellation?: CancellationController,
): Promise<ReadonlySet<Machine>> {
  const candidates = preflights.filter(
    (preflight) => preflight.stage.status === "OK" && preflight.branch !== "dev",
  );
  if (candidates.length === 0) return new Set();
  let state: SelectorState = { cursor: 0, selected: new Set() };
  return runRawPrompt(
    input,
    output,
    () =>
      [
        "Switch clean targets to dev? (Space toggles, Enter confirms):",
        ...candidates.map((preflight, index) => {
          const pointer = index === state.cursor ? ">" : " ";
          const selected = state.selected.has(index) ? "[x]" : "[ ]";
          return `${pointer} ${selected} ${preflight.target} (${preflight.branch} → dev)`;
        }),
      ].join("\n") + "\n",
    (key) => {
      if (key === "confirm") {
        return new Set(
          candidates
            .filter((_, index) => state.selected.has(index))
            .map((preflight) => preflight.target),
        );
      }
      state = reduceSelector(state, key, candidates.length);
      return undefined;
    },
    undefined,
    cancellation,
  );
}

export async function decidePreflights(
  preflights: ReadonlyArray<PreflightResult>,
  input: TerminalInput,
  output: TerminalOutput,
  cancellation?: CancellationController,
): Promise<ReadonlyArray<PreflightDecision>> {
  const switchable = preflights.filter(
    (preflight) => preflight.stage.status === "OK" && preflight.branch !== "dev",
  );
  const approved =
    switchable.length === 0
      ? new Set<Machine>()
      : hasInteractiveTerminal(input, output)
        ? await selectBranchSwitches(preflights, input, output, cancellation)
        : new Set<Machine>();
  return preflights.map((preflight) => {
    if (preflight.stage.status !== "OK") return { preflight, approved: false };
    if (preflight.branch === "dev" || approved.has(preflight.target)) {
      return { preflight, approved: true };
    }
    return {
      preflight,
      approved: false,
      skipDetail: hasInteractiveTerminal(input, output)
        ? "dev switch declined"
        : "non-TTY non-dev target",
    };
  });
}

function reportPartialUpdatePlan(
  plan: UpdatePlan,
  decisions: ReadonlyArray<PreflightDecision>,
  log: (line: string) => void,
): void {
  const approved = decisions.filter((decision) => decision.approved);
  const excluded = decisions.filter((decision) => !decision.approved);
  log("\nPartial update plan");
  for (const decision of approved) {
    const branchAction =
      decision.preflight.branch === "dev"
        ? ""
        : ` — switch ${decision.preflight.branch ?? "unknown"} → dev, then update`;
    log(`  RUN   ${selectedTargetLabel(plan, decision.preflight.target)}${branchAction}`);
  }
  for (const decision of excluded) {
    const detail = decision.skipDetail ?? preflightIssueDetail(decision.preflight);
    log(`  SKIP  ${selectedTargetLabel(plan, decision.preflight.target)} — ${detail}`);
  }
}

async function promptContinuePartialUpdate(
  remainingCount: number,
  input: TerminalInput,
  output: TerminalOutput,
  cancellation?: CancellationController,
): Promise<boolean> {
  const noun = remainingCount === 1 ? "environment" : "environments";
  return runRawPrompt(
    input,
    output,
    () => `Continue with the ${String(remainingCount)} remaining ${noun}? [y/N] `,
    (key, raw) => {
      if (key === "confirm") return false;
      if (raw.toLowerCase() === "y") return true;
      if (raw.toLowerCase() === "n") return false;
      return undefined;
    },
    false,
    cancellation,
  );
}

function developmentLogRoot(homeDir: string, env: NodeJS.ProcessEnv): string {
  const configuredT3Home = env.T3CODE_HOME?.trim();
  const t3Home = NodePath.resolve(configuredT3Home || NodePath.join(homeDir, ".t3"));
  return NodePath.join(t3Home, configuredT3Home ? "userdata" : "dev", "logs", "machine-update");
}

export function createDefaultDependencies(
  runner: CommandRunner,
  log: (line: string) => void = console.log,
  progress?: ProgressReporter,
): UpdateDependencies {
  const homeDir = NodeOS.homedir();
  return {
    runner,
    homeDir,
    env: process.env,
    pathExists: NodeFS.existsSync,
    log,
    progress,
    ...(runner.dryRun
      ? {}
      : {
          logRoot: developmentLogRoot(homeDir, process.env),
          runId: `${new Date().toISOString().replaceAll(/[:.]/gu, "-")}-${String(process.pid)}`,
        }),
  };
}

function jobLogPath(dependencies: UpdateDependencies, jobId: string): string | undefined {
  return dependencies.logRoot && dependencies.runId
    ? NodePath.join(dependencies.logRoot, dependencies.runId, `${jobId}.log`)
    : undefined;
}

function targetStatus(result: TargetResult): "OK" | "FAILED" | "SKIPPED" | "CANCELLED" {
  if (result.stages.some((stage) => stage.status === "CANCELLED")) return "CANCELLED";
  if (result.stages.some((stage) => stage.status === "FAILED")) return "FAILED";
  if (result.stages.length > 0 && result.stages.every((stage) => stage.status === "SKIPPED")) {
    return "SKIPPED";
  }
  return "OK";
}

export async function runRemoteTarget(
  target: Machine,
  dependencies: UpdateDependencies,
  preflight?: PreflightResult,
): Promise<TargetResult> {
  const jobId = `remote-${target}`;
  const label = `${target} desktop`;
  const logPath = jobLogPath(dependencies, jobId);
  dependencies.progress?.start(jobId, label, "checkout");
  let stageBuffer = "";
  const request = buildRemoteCommand(target, logPath, preflight?.checkout, preflight?.branch);
  const result = await dependencies.runner.run({
    ...request,
    onOutput: (chunk) => {
      stageBuffer = (stageBuffer + chunk).slice(-STAGE_MARKER_TAIL_CHARS);
      const lines = stageBuffer.split(/[\r\n]/u);
      stageBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const stage = /^__T3_STAGE__ (checkout|pull|dependencies|desktop)$/u.exec(line)?.[1];
        if (stage) dependencies.progress?.stage(jobId, stage);
      }
    },
  });
  const targetResult = {
    target,
    label,
    stages: [
      ...(preflight
        ? ([{ stage: "preflight", status: "OK" }] satisfies ReadonlyArray<StageResult>)
        : []),
      ...remoteResults(result),
    ],
    logPath,
    hasLog: logPath !== undefined && (dependencies.runner.hasLog?.(logPath) ?? false),
  };
  dependencies.progress?.finish(jobId, targetStatus(targetResult));
  return targetResult;
}

function remainingLocalStages(
  plan: LocalUpdatePlan,
  fromPrepIndex: number,
): ReadonlyArray<UpdateStage> {
  return [
    ...PREP_STAGES.slice(fromPrepIndex),
    ...(plan.desktop ? (["desktop"] as const) : []),
    ...(plan.ios ? (["ios"] as const) : []),
  ];
}

export async function runLocalTarget(
  plan: LocalUpdatePlan,
  dependencies: UpdateDependencies,
  preflight?: PreflightResult,
): Promise<TargetResult> {
  const jobId = `local-${plan.machine}`;
  const selectedSurfaces = [plan.desktop ? "desktop" : "", plan.ios ? "iOS" : ""]
    .filter(Boolean)
    .join(" + ");
  const label = `${plan.machine} ${selectedSurfaces}`;
  const logPath = jobLogPath(dependencies, jobId);
  const stages: StageResult[] = preflight
    ? [{ stage: "preflight", status: "OK" } satisfies StageResult]
    : [];
  dependencies.progress?.start(jobId, label, "checkout");

  const checkoutResult = preflight?.checkout
    ? {
        checkout: preflight.checkout,
        result: { stage: "checkout", status: "OK" } satisfies StageResult,
      }
    : await resolveLocalCheckout(dependencies, plan.machine, logPath);
  stages.push(checkoutResult.result);
  if (checkoutResult.result.status !== "OK" || checkoutResult.checkout === undefined) {
    const status = checkoutResult.result.status === "CANCELLED" ? "CANCELLED" : "SKIPPED";
    stages.push(...remainingLocalStages(plan, 1).map((stage): StageResult => ({ stage, status })));
    const result = {
      target: plan.machine,
      label,
      stages,
      logPath,
      hasLog: logPath !== undefined && (dependencies.runner.hasLog?.(logPath) ?? false),
    };
    dependencies.progress?.finish(jobId, targetStatus(result));
    return result;
  }

  const checkout = checkoutResult.checkout;
  if (preflight && dependencies.defensiveRevalidation !== false) {
    const expectedBranch = preflight.branch ?? "dev";
    const [status, branch] = await Promise.all([
      dependencies.runner.run({
        target: plan.machine,
        stage: "checkout",
        command: "git",
        args: ["status", "--porcelain=v1", "--untracked-files=all"],
        cwd: checkout,
        logPath,
      }),
      dependencies.runner.run({
        target: plan.machine,
        stage: "checkout",
        command: "git",
        args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
        cwd: checkout,
        logPath,
      }),
    ]);
    if (status.cancelled || branch.cancelled) {
      stages.push({ stage: "preflight", status: "CANCELLED" });
      stages.push(
        ...remainingLocalStages(plan, 1).map(
          (stage): StageResult => ({ stage, status: "CANCELLED" }),
        ),
      );
      const result = {
        target: plan.machine,
        label,
        stages,
        logPath,
        hasLog: logPath !== undefined && (dependencies.runner.hasLog?.(logPath) ?? false),
      };
      dependencies.progress?.finish(jobId, targetStatus(result));
      return result;
    }
    const branchReadable = branch.exitCode === 0 || branch.exitCode === 1;
    const actualBranch = branch.exitCode === 0 ? branch.stdoutTail.trim() : "DETACHED";
    if (
      status.exitCode !== 0 ||
      !branchReadable ||
      status.stdoutTail.length > 0 ||
      actualBranch !== expectedBranch
    ) {
      stages.push({
        stage: "preflight",
        status: "FAILED",
        detail: "checkout changed after preflight",
      });
      stages.push(
        ...remainingLocalStages(plan, 1).map(
          (stage): StageResult => ({ stage, status: "SKIPPED" }),
        ),
      );
      const result = {
        target: plan.machine,
        label,
        stages,
        logPath,
        hasLog: logPath !== undefined && (dependencies.runner.hasLog?.(logPath) ?? false),
      };
      dependencies.progress?.finish(jobId, targetStatus(result));
      return result;
    }
    if (actualBranch !== "dev") {
      const switched = await dependencies.runner.run({
        target: plan.machine,
        stage: "checkout",
        command: "git",
        args: ["switch", "dev"],
        cwd: checkout,
        logPath,
      });
      if (switched.exitCode !== 0 || switched.cancelled) {
        stages.push(commandFailure("preflight", switched));
        stages.push(
          ...remainingLocalStages(plan, 1).map(
            (stage): StageResult => ({ stage, status: "SKIPPED" }),
          ),
        );
        const result = {
          target: plan.machine,
          label,
          stages,
          logPath,
          hasLog: logPath !== undefined && (dependencies.runner.hasLog?.(logPath) ?? false),
        };
        dependencies.progress?.finish(jobId, targetStatus(result));
        return result;
      }
    }
    const cleanDev =
      actualBranch === "dev"
        ? undefined
        : await Promise.all([
            dependencies.runner.run({
              target: plan.machine,
              stage: "checkout",
              command: "git",
              args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
              cwd: checkout,
              logPath,
            }),
            dependencies.runner.run({
              target: plan.machine,
              stage: "checkout",
              command: "git",
              args: ["status", "--porcelain=v1", "--untracked-files=all"],
              cwd: checkout,
              logPath,
            }),
          ]);
    if (cleanDev?.some((result) => result.cancelled)) {
      stages.push({ stage: "preflight", status: "CANCELLED" });
      stages.push(
        ...remainingLocalStages(plan, 1).map(
          (stage): StageResult => ({ stage, status: "CANCELLED" }),
        ),
      );
      const result = {
        target: plan.machine,
        label,
        stages,
        logPath,
        hasLog: logPath !== undefined && (dependencies.runner.hasLog?.(logPath) ?? false),
      };
      dependencies.progress?.finish(jobId, targetStatus(result));
      return result;
    }
    if (
      cleanDev !== undefined &&
      (cleanDev[0].exitCode !== 0 ||
        cleanDev[0].stdoutTail.trim() !== "dev" ||
        cleanDev[1].exitCode !== 0 ||
        cleanDev[1].stdoutTail.length > 0)
    ) {
      stages.push({ stage: "preflight", status: "FAILED", detail: "expected clean dev checkout" });
      stages.push(
        ...remainingLocalStages(plan, 1).map(
          (stage): StageResult => ({ stage, status: "SKIPPED" }),
        ),
      );
      const result = {
        target: plan.machine,
        label,
        stages,
        logPath,
        hasLog: logPath !== undefined && (dependencies.runner.hasLog?.(logPath) ?? false),
      };
      dependencies.progress?.finish(jobId, targetStatus(result));
      return result;
    }
  }
  for (const [index, stage, command, args] of [
    [1, "pull", "git", ["pull", "--ff-only"]],
    [2, "dependencies", "pnpm", ["install"]],
  ] as const) {
    dependencies.progress?.stage(jobId, stage);
    const commandResult = await dependencies.runner.run({
      target: plan.machine,
      stage,
      command,
      args,
      cwd: checkout,
      logPath,
    });
    if (commandResult.exitCode === 0 && !commandResult.cancelled) {
      stages.push({ stage, status: "OK" });
      continue;
    }
    stages.push(commandFailure(stage, commandResult));
    const status = commandResult.cancelled ? "CANCELLED" : "SKIPPED";
    stages.push(
      ...remainingLocalStages(plan, index + 1).map(
        (remainingStage): StageResult => ({ stage: remainingStage, status }),
      ),
    );
    const result = {
      target: plan.machine,
      label,
      stages,
      logPath,
      hasLog: logPath !== undefined && (dependencies.runner.hasLog?.(logPath) ?? false),
    };
    dependencies.progress?.finish(jobId, targetStatus(result));
    return result;
  }

  const surfaces: ReadonlyArray<readonly ["desktop" | "ios", string, ReadonlyArray<string>]> = [
    ...(plan.desktop ? ([["desktop", "pnpm", ["run", "install:desktop:dev"]]] as const) : []),
    ...(plan.ios ? ([["ios", "pnpm", ["run", "ios:local:release"]]] as const) : []),
  ];
  for (const [stage, command, args] of surfaces) {
    dependencies.progress?.stage(jobId, stage);
    const interactiveTerminal =
      stage === "ios" &&
      !dependencies.runner.dryRun &&
      dependencies.input?.isTTY === true &&
      dependencies.input.setRawMode !== undefined &&
      dependencies.output?.isTTY === true;
    if (interactiveTerminal) dependencies.progress?.suspend();
    let commandResult: CommandResult;
    try {
      commandResult = await dependencies.runner.run({
        target: plan.machine,
        stage,
        command,
        args,
        cwd: checkout,
        logPath,
        ...(interactiveTerminal ? { interactiveTerminal: true } : {}),
      });
    } finally {
      if (interactiveTerminal) {
        try {
          dependencies.input.setRawMode(false);
        } catch {
          // Expo may already have released or closed terminal input.
        }
        dependencies.progress?.resume();
      }
    }
    stages.push(
      commandResult.exitCode === 0 && !commandResult.cancelled
        ? { stage, status: "OK" }
        : commandFailure(stage, commandResult),
    );
    if (commandResult.cancelled) {
      const remaining = surfaces.slice(
        surfaces.findIndex(([candidate]) => candidate === stage) + 1,
      );
      stages.push(
        ...remaining.map(
          ([remainingStage]): StageResult => ({
            stage: remainingStage,
            status: "CANCELLED",
          }),
        ),
      );
      break;
    }
  }

  const result = {
    target: plan.machine,
    label,
    stages,
    logPath,
    hasLog: logPath !== undefined && (dependencies.runner.hasLog?.(logPath) ?? false),
  };
  dependencies.progress?.finish(jobId, targetStatus(result));
  return result;
}

function cleanupLogPaths(paths: ReadonlyArray<string>): void {
  for (const path of paths) {
    try {
      NodeFS.rmSync(path, { force: true });
    } catch {
      // Failure logging is best-effort and must not change the update result.
    }
  }
  for (const runDir of new Set(paths.map(NodePath.dirname))) {
    try {
      if (NodeFS.readdirSync(runDir).length === 0) NodeFS.rmdirSync(runDir);
    } catch {
      // A concurrent cleanup or absent log directory needs no action.
    }
  }
}

function cleanupSuccessfulLogs(results: ReadonlyArray<TargetResult>): void {
  cleanupLogPaths(
    results.flatMap((result) =>
      targetStatus(result) !== "FAILED" && result.logPath ? [result.logPath] : [],
    ),
  );
}

function skippedPreflightTarget(plan: UpdatePlan, decision: PreflightDecision): TargetResult {
  const local = plan.local?.machine === decision.preflight.target ? plan.local : undefined;
  const remaining = [
    "checkout",
    "pull",
    "dependencies",
    ...(local?.desktop || !local ? (["desktop"] as const) : []),
    ...(local?.ios ? (["ios"] as const) : []),
  ] as const;
  return {
    target: decision.preflight.target,
    label: selectedTargetLabel(plan, decision.preflight.target),
    logPath: decision.preflight.logPath,
    hasLog: decision.preflight.hasLog,
    stages:
      decision.preflight.stage.status === "FAILED" ||
      decision.preflight.stage.status === "CANCELLED"
        ? [
            decision.preflight.stage,
            ...remaining.map((stage): StageResult => ({ stage, status: "SKIPPED" })),
          ]
        : [
            {
              stage: "preflight",
              status: "SKIPPED",
              detail: decision.skipDetail,
            },
            ...remaining.map((stage): StageResult => ({ stage, status: "SKIPPED" })),
          ],
  };
}

export async function prepareUpdatePlan(
  plan: UpdatePlan,
  dependencies: UpdateDependencies,
  cancellation = new CancellationController(),
): Promise<PreparedUpdatePlan> {
  const unsubscribe = cancellation.onCancel(dependencies.runner.cancel);
  try {
    const preflights = await (dependencies.inspectPlan ?? preflightUpdatePlan)(plan, dependencies);
    if (cancellation.cancelled) {
      return {
        plan,
        decisions: preflights.map((preflight) => ({
          approved: false,
          preflight: {
            ...preflight,
            stage: { stage: "preflight", status: "CANCELLED" },
          },
        })),
      };
    }
    const input = dependencies.input ?? ({ isTTY: false } as TerminalInput);
    const output =
      dependencies.output ?? ({ isTTY: false, write: () => undefined } as TerminalOutput);
    reportPreflightIssues(
      plan,
      preflights,
      hasInteractiveTerminal(input, output),
      dependencies.log,
    );
    const decisions = await decidePreflights(preflights, input, output, cancellation);
    const approvedCount = decisions.filter((decision) => decision.approved).length;
    const excludedCount = decisions.length - approvedCount;
    if (hasInteractiveTerminal(input, output) && approvedCount > 0 && excludedCount > 0) {
      reportPartialUpdatePlan(plan, decisions, dependencies.log);
      if (!(await promptContinuePartialUpdate(approvedCount, input, output, cancellation))) {
        cleanupLogPaths(
          preflights.flatMap((preflight) => (preflight.logPath ? [preflight.logPath] : [])),
        );
        throw new MachineUpdateError("Cancelled before updates.", 130);
      }
    }
    return { plan, decisions };
  } finally {
    unsubscribe();
  }
}

export function buildProgressRows(
  prepared: PreparedUpdatePlan,
): ReadonlyArray<readonly [string, string]> {
  return prepared.decisions.flatMap((decision): ReadonlyArray<readonly [string, string]> => {
    if (!decision.approved) return [];
    const local = prepared.plan.local?.machine === decision.preflight.target;
    return [
      [
        `${local ? "local" : "remote"}-${decision.preflight.target}`,
        selectedTargetLabel(prepared.plan, decision.preflight.target),
      ],
    ];
  });
}

export async function executePreparedUpdatePlan(
  prepared: PreparedUpdatePlan,
  dependencies: UpdateDependencies,
  cancellation = new CancellationController(),
): Promise<ExecutionResult> {
  const { plan, decisions } = prepared;
  if (cancellation.cancelled) {
    const results = decisions.map((decision) =>
      skippedPreflightTarget(plan, {
        ...decision,
        preflight: {
          ...decision.preflight,
          stage: { stage: "preflight", status: "CANCELLED" },
        },
      }),
    );
    return { results, cancelled: true };
  }
  const unsubscribe = cancellation.onCancel(dependencies.runner.cancel);
  try {
    const byTarget = new Map(decisions.map((decision) => [decision.preflight.target, decision]));
    const jobs: Array<Promise<TargetResult>> = plan.remoteTargets.map((target) => {
      const decision = byTarget.get(target)!;
      return decision.approved
        ? runRemoteTarget(target, dependencies, decision.preflight)
        : Promise.resolve(skippedPreflightTarget(plan, decision));
    });
    if (plan.local) {
      const decision = byTarget.get(plan.local.machine)!;
      jobs.push(
        decision.approved
          ? runLocalTarget(plan.local, dependencies, decision.preflight)
          : Promise.resolve(skippedPreflightTarget(plan, decision)),
      );
    }
    const results = await Promise.all(jobs);
    cleanupSuccessfulLogs(results);
    return { results, cancelled: cancellation.cancelled };
  } catch (error) {
    dependencies.runner.cancel();
    throw error;
  } finally {
    unsubscribe();
  }
}

export async function executeUpdatePlan(
  plan: UpdatePlan,
  dependencies: UpdateDependencies,
  cancellation = new CancellationController(),
): Promise<ExecutionResult> {
  const prepared = await prepareUpdatePlan(plan, dependencies, cancellation);
  return executePreparedUpdatePlan(prepared, dependencies, cancellation);
}

export function printSummary(
  results: ReadonlyArray<TargetResult>,
  log: (line: string) => void = console.log,
): void {
  log("\nSummary");
  if (results.length === 0) {
    log("No updates selected.");
    return;
  }
  for (const result of results) {
    log(result.label);
    for (const stage of result.stages) {
      log(`  ${stage.status.padEnd(9)} ${stage.stage}${stage.detail ? ` (${stage.detail})` : ""}`);
      const headline = stage.tail?.split("\n").find((line) => line.trim().length > 0);
      if (headline) log(`    ${headline.slice(0, 160)}`);
    }
    if (targetStatus(result) === "FAILED" && result.hasLog && result.logPath)
      log(`  Log: ${result.logPath}`);
  }
}

export function failureLogPaths(results: ReadonlyArray<TargetResult>): ReadonlyArray<string> {
  return results.flatMap((result) =>
    targetStatus(result) === "FAILED" && result.hasLog && result.logPath ? [result.logPath] : [],
  );
}

export function resultExitCode(execution: ExecutionResult): 0 | 1 | 130 {
  if (
    execution.cancelled ||
    execution.results.some((result) => targetStatus(result) === "CANCELLED")
  ) {
    return 130;
  }
  return execution.results.some((target) =>
    target.stages.some((stage) => stage.status === "FAILED"),
  )
    ? 1
    : 0;
}

export function validateSelectedHosts(
  hosts: ReadonlyArray<string>,
  eligibleTargets: ReadonlyArray<Machine>,
): ReadonlyArray<Machine> {
  const eligible = new Set(eligibleTargets);
  const selected: Machine[] = [];
  for (const host of hosts) {
    if (!FLEET.includes(host as Machine)) {
      throw new MachineUpdateError(
        `Unknown fleet host "${host}". Expected one of: ${FLEET.join(", ")}.`,
      );
    }
    const target = host as Machine;
    if (!eligible.has(target)) {
      throw new MachineUpdateError(
        `Host "${target}" is not eligible: it is local or has no literal alias in ~/.ssh/config.`,
      );
    }
    if (!selected.includes(target)) selected.push(target);
  }
  return selected;
}

export function createProgressReporter(
  rows: ReadonlyArray<readonly [string, string]>,
  output: TerminalOutput,
): ProgressReporter {
  type ProgressStatus = "RUNNING" | "OK" | "FAILED" | "SKIPPED" | "CANCELLED";
  interface ProgressState {
    readonly label: string;
    readonly stage: string;
    readonly status: ProgressStatus;
  }
  const state = new Map<string, ProgressState>(
    rows.map(([id, label]) => [id, { label, stage: "waiting", status: "RUNNING" }]),
  );
  if (!output.isTTY) {
    return {
      start: (jobId, label, stage) => {
        state.set(jobId, { label, stage, status: "RUNNING" });
        output.write(`[start] ${label}: ${stage}\n`);
      },
      stage: (jobId, stage) => {
        const current = state.get(jobId);
        if (current) state.set(jobId, { ...current, stage });
      },
      finish: (jobId, status) => {
        const current = state.get(jobId);
        const label = current?.label ?? jobId;
        if (current) state.set(jobId, { ...current, status });
        output.write(`[finish] ${label}: ${status}\n`);
      },
      suspend: () => undefined,
      resume: () => undefined,
      close: () => undefined,
    };
  }

  let rendered = false;
  let suspended = false;
  let closed = false;
  const render = () => {
    if (closed || suspended) return;
    if (rendered) output.write(`[${String(rows.length)}A`);
    for (const [id, fallbackLabel] of rows) {
      const current = state.get(id);
      const label = current?.label ?? fallbackLabel;
      const status = current?.status ?? "RUNNING";
      output.write(`[2K${status} ${label} — ${status === "RUNNING" ? current?.stage : status}\n`);
    }
    rendered = true;
  };
  const clear = () => {
    if (!rendered) return;
    if (rows.length > 0) output.write(`[${String(rows.length)}A`);
    output.write("[J");
    rendered = false;
  };
  output.write("[?25l");
  render();
  return {
    start: (jobId, label, stage) => {
      state.set(jobId, { label, stage, status: "RUNNING" });
      render();
    },
    stage: (jobId, stage) => {
      const current = state.get(jobId);
      if (current) {
        state.set(jobId, { ...current, stage });
        render();
      }
    },
    finish: (jobId, status) => {
      const current = state.get(jobId);
      if (current) state.set(jobId, { ...current, status });
      render();
    },
    suspend: () => {
      if (closed || suspended) return;
      clear();
      suspended = true;
      output.write("[?25h");
    },
    resume: () => {
      if (closed || !suspended) return;
      suspended = false;
      output.write("\n[?25l");
      render();
    },
    close: () => {
      if (closed) return;
      closed = true;
      output.write("[?25h");
    },
  };
}

export function shouldPromptForFailureLogs(
  results: ReadonlyArray<TargetResult>,
  inputIsTty: boolean,
  outputIsTty: boolean,
  showFailureLogs: boolean,
): boolean {
  return !showFailureLogs && inputIsTty && outputIsTty && failureLogPaths(results).length > 0;
}

export async function promptShowFailureLogs(
  input: TerminalInput,
  output: TerminalOutput,
): Promise<boolean> {
  return runRawPrompt(
    input,
    output,
    () => "Show full logs for failed jobs? [y/N] ",
    (key, raw) => {
      if (key === "confirm") return false;
      if (raw.toLowerCase() === "y") return true;
      if (raw.toLowerCase() === "n") return false;
      return undefined;
    },
    false,
  );
}

export async function showLogs(
  paths: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  output: TerminalOutput,
): Promise<void> {
  if (paths.length === 0) return;
  const contents = paths
    .map((path) => {
      try {
        return `===== ${path} =====\n${NodeFS.readFileSync(path, "utf8")}`;
      } catch (error) {
        return `===== ${path} =====\n(unreadable: ${String(error)})`;
      }
    })
    .join("\n");
  const configuredPager = env.PAGER?.trim();
  const pager = configuredPager ? configuredPager.split(/\s+/u) : ["less", "-R"];
  const [command, ...args] = pager;
  if (!command) {
    output.write(`${contents}\n`);
    return;
  }
  const displayed = await new Promise<boolean>((resolve) => {
    const child = NodeChildProcess.spawn(command, args, {
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(contents);
  });
  if (!displayed) output.write(`${contents}\n`);
}

async function readSshAliases(homeDir: string): Promise<ReadonlyArray<string>> {
  return Effect.runPromise(
    collectSshConfigAliasesFromFile(
      NodePath.join(homeDir, ".ssh", "config"),
      new Set<string>(),
      homeDir,
    ).pipe(Effect.provide(NodeServices.layer)),
  );
}

export const HELP = `Usage: pnpm update:machines [options]

With no selection flags, one arrow/Space selector lists remote desktops plus local desktop and, on macOS, local iOS. Every row starts unchecked. Any explicit selection flag defines the complete plan and suppresses the selector. All selected checkouts are inspected concurrently and dirty, uninspectable, or non-dev states are shown before mutation. Clean non-dev targets can be approved in one unchecked batch to switch to dev. When some selected targets are eligible and others are excluded, interactive runs ask (default No) before continuing with the eligible remainder; non-TTY runs skip non-dev targets while dirty or uninspectable targets fail.

Options:
  --host <alias>              Select a remote fleet desktop; repeatable
  --include-local-desktop     Update the desktop on this machine
  --no-local-desktop          Explicitly omit this machine's desktop
  --include-local-ios         Build and install iOS on this macOS machine
  --no-local-ios              Explicitly omit local iOS
  --local-machine <name>      Override normalized hostname detection
  --dry-run                   Print synthetic commands; never spawn update processes
  --fail <target:stage>       Simulate a dry-run failure; repeatable
  --show-failure-logs         Show retained failure logs without prompting
  -h, --help                  Show help

Examples:
  pnpm update:machines
  pnpm update:machines -- --host grey-mac --include-local-desktop
  pnpm update:machines -- --include-local-desktop --include-local-ios
  pnpm update:machines -- --host grey-mac --dry-run --fail grey-mac:pull`;

export async function main(
  args: ReadonlyArray<string>,
  input: TerminalInput,
  output: TerminalOutput,
  platform: NodeJS.Platform,
): Promise<number> {
  const options = parseCliArgs(args);
  if (options.help) {
    output.write(`${HELP}\n`);
    return 0;
  }
  if (!input.isTTY && !options.explicitSelection) {
    throw new MachineUpdateError(
      "Non-TTY use requires --host or an explicit local desktop/iOS selection flag.",
    );
  }

  const homeDir = NodeOS.homedir();
  const hostname = NodeOS.hostname();
  const macLocalHostname =
    options.localMachine === undefined && platform === "darwin"
      ? readMacLocalHostname()
      : undefined;
  const localMachine = resolveLocalMachine(
    hostname,
    options.localMachine,
    macLocalHostname === undefined ? [] : [macLocalHostname],
  );
  const needsRemoteChoices = !options.explicitSelection || options.hosts.length > 0;
  const eligibleTargets = needsRemoteChoices
    ? getEligibleRemoteTargets(localMachine, await readSshAliases(homeDir))
    : [];
  const choices = buildSelectionChoices(eligibleTargets, localMachine, platform);
  const plan = options.explicitSelection
    ? createExplicitPlan(options, localMachine, platform, eligibleTargets)
    : await selectUpdatePlan(choices, input, output);
  const failures = parseSimulatedFailures(options.simulatedFailures);
  validateSimulatedFailures(failures, plan);

  const lineLog = (line: string) => output.write(`${line}\n`);
  const runner = options.dryRun
    ? createDryRunRunner(failures, lineLog)
    : createRealRunner(platform);
  const baseDependencies = {
    ...createDefaultDependencies(runner, lineLog),
    input,
    output,
  };
  const cancellation = new CancellationController();
  let interrupts = 0;
  const onSigint = () => {
    interrupts += 1;
    if (interrupts === 1) cancellation.cancel();
    else runner.cancel(true);
  };
  const onTerminate = () => {
    cancellation.cancel();
    runner.cancel(true);
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onTerminate);
  process.on("SIGHUP", onTerminate);
  let execution: ExecutionResult;
  let progress: ProgressReporter | undefined;
  try {
    const prepared = await prepareUpdatePlan(plan, baseDependencies, cancellation);
    progress = createProgressReporter(
      buildProgressRows(prepared),
      runner.dryRun ? { isTTY: false, write: () => undefined } : output,
    );
    execution = await executePreparedUpdatePlan(
      prepared,
      { ...baseDependencies, progress },
      cancellation,
    );
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onTerminate);
    process.off("SIGHUP", onTerminate);
    progress?.close();
  }

  printSummary(execution.results, lineLog);
  const paths = failureLogPaths(execution.results);
  const showFailureLogs =
    options.showFailureLogs ||
    (shouldPromptForFailureLogs(
      execution.results,
      Boolean(input.isTTY && input.setRawMode !== undefined),
      Boolean(output.isTTY),
      options.showFailureLogs,
    ) &&
      (await promptShowFailureLogs(input, output)));
  if (showFailureLogs) await showLogs(paths, process.env, output);
  return resultExitCode(execution);
}

if (import.meta.main) {
  Effect.runPromise(
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      return yield* Effect.promise(() =>
        main(process.argv.slice(2), process.stdin, process.stdout, platform),
      );
    }),
  ).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      const known =
        error instanceof MachineUpdateError ? error : new MachineUpdateError(String(error));
      console.error(`machine-update: ${known.message}`);
      process.exitCode = known.exitCode;
    },
  );
}
