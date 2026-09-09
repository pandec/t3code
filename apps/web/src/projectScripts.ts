import {
  SCRIPT_RUN_COMMAND_PATTERN,
  type ExecutionEnvironmentDescriptor,
  type KeybindingCommand,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export {
  buildProjectScript,
  nextProjectScriptId,
  normalizeProjectSetupScript,
  primaryProjectScript,
  type ProjectScriptInput,
} from "@t3tools/shared/projectScripts";

const isScriptRunCommand = Schema.is(SCRIPT_RUN_COMMAND_PATTERN);

/** Legacy script IDs may not support shortcuts; keep those scripts usable without one. */
export function commandForProjectScript(scriptId: string): KeybindingCommand | null {
  const command = `script.${scriptId}.run`;
  return isScriptRunCommand(command) ? command : null;
}

export function projectScriptIdFromCommand(command: string): string | null {
  const trimmed = command.trim();
  if (!isScriptRunCommand(trimmed)) {
    return null;
  }
  const [prefix, , suffix] = SCRIPT_RUN_COMMAND_PATTERN.parts;
  return trimmed.slice(prefix.literal.length, -suffix.literal.length);
}

export function projectActionMutationUnavailableMessage(
  environment: ExecutionEnvironmentDescriptor | null | undefined,
): string | null {
  if (environment?.capabilities.conditionalProjectScriptUpdates === true) {
    return null;
  }
  const version = environment?.serverVersion;
  return `The connected T3 Code server${version ? ` (${version})` : ""} does not support safe project action updates. Update or refresh T3 Code, then retry.`;
}
