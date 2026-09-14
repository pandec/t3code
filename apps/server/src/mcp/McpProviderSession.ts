import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import type { McpCapability } from "./McpInvocationContext.ts";

/**
 * Per-call budget the provider CLI gives a `t3-code` MCP tool before it
 * abandons the request. Claude Code and Codex both default to 60 seconds,
 * which `voice_reply` outlives: speech synthesis is allowed two minutes per
 * request, and a Gemini script of a few thousand characters routinely needs
 * more than a minute. Progress heartbeats do not extend either client's
 * limit, so the budget must cover the longest handler outright. Four minutes
 * clears synthesis and a simulator boot with room to spare.
 */
export const MCP_TOOL_CALL_TIMEOUT_MS = 240_000;

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /** The toolkits the credential grants; pull requests are always included. */
  readonly capabilities: ReadonlySet<McpCapability>;
  /**
   * Set when the session may drive devices. Adapters spread this into the
   * provider subprocess environment so the `agent-device` CLI is on PATH.
   * device_open supplies the config for the selected host.
   */
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
}

/** Provider env with the device variables applied over `base`, or `base` untouched. */
export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByThread.set(config.threadId, config);
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId);
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}
