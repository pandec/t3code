import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

/**
 * Per-call budget the provider CLI gives a `t3-code` MCP tool. Claude Code and Codex default to
 * 60s, which `voice_reply` outlives (synthesis may take two minutes), and progress heartbeats do
 * not extend it, so this must cover the longest handler outright.
 */
export const MCP_TOOL_CALL_TIMEOUT_MS = 240_000;

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /** Omit preview_* instructions when the user withholds agent browser access. */
  readonly browserToolsAvailable: boolean;
  /**
   * The toolkits the credential grants; orchestration, worktree and pull
   * requests are always included. The server narrows these to its
   * `McpCapability` union when it issues the credential.
   */
  readonly capabilities?: ReadonlySet<string>;
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
}

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
