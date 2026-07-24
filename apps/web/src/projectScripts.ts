import { SCRIPT_RUN_COMMAND_PATTERN, type KeybindingCommand } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export {
  buildProjectScript,
  nextProjectScriptId,
  normalizeProjectSetupScript,
  primaryProjectScript,
  type ProjectScriptInput,
} from "@t3tools/shared/projectScripts";

const isScriptRunCommand = Schema.is(SCRIPT_RUN_COMMAND_PATTERN);

export const commandForProjectScript = (scriptId: string): KeybindingCommand =>
  SCRIPT_RUN_COMMAND_PATTERN.make(`script.${scriptId}.run`);

export function projectScriptIdFromCommand(command: string): string | null {
  const trimmed = command.trim();
  if (!isScriptRunCommand(trimmed)) {
    return null;
  }
  const [prefix, , suffix] = SCRIPT_RUN_COMMAND_PATTERN.parts;
  return trimmed.slice(prefix.literal.length, -suffix.literal.length);
}
