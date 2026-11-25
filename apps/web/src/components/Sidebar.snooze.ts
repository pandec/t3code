import type { EnvironmentId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { msg } from "gt-react";
import {
  pickSnoozePreset as pickSharedSnoozePreset,
  resolveSnoozePresets as resolveSharedSnoozePresets,
  SNOOZE_UNTIL_DONE_PRESET,
  snoozeWakeLabel,
  type SnoozePreset as SharedSnoozePreset,
} from "@t3tools/client-runtime/state/thread-settled";

import { m, type MessageResolver } from "../i18n/messages";
import { getFormattingLocale } from "../i18n/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "../state/server";
import { formatShortTimestamp } from "../timestampFormat";
import { toastManager } from "./ui/toast";

export { snoozeWakeLabel };

/** The shared timed presets plus the fork's "Until it's done". */
export interface SnoozePreset extends Omit<SharedSnoozePreset, "id" | "snoozedUntil"> {
  readonly id: SharedSnoozePreset["id"] | "until-done";
  /** ISO wake time, or null for the "until it's done" snooze. */
  readonly snoozedUntil: string | null;
  /** "Until it's done": wake when the running work and its subagents end. */
  readonly untilDone?: true;
}

/**
 * The snooze menu for a thread, from its environment's presets, read when the menu opens.
 * "Until it's done" leads when the caller offers it (a working thread on a server with
 * threadSnoozeUntilDone).
 */
export function resolveSnoozePresets(
  now: Date,
  timestampFormat: TimestampFormat,
  environmentId: EnvironmentId,
  options?: { readonly untilDone?: boolean },
  resolve: MessageResolver = m,
): ReadonlyArray<SnoozePreset> {
  const presets: SnoozePreset[] = [
    ...resolveSharedSnoozePresets(now, snoozeOptions(timestampFormat, environmentId), resolve),
  ];
  if (options?.untilDone === true) {
    presets.unshift({ ...SNOOZE_UNTIL_DONE_PRESET, snoozedUntil: null, untilDone: true });
  }
  return presets;
}

/** A shown menu choice as picked; see the shared `pickSnoozePreset`. */
export function pickSnoozePreset(
  shown: ReadonlyArray<SnoozePreset>,
  id: string,
  timestampFormat: TimestampFormat,
  environmentId: EnvironmentId,
  resolve: MessageResolver = m,
): SnoozePreset | undefined {
  if (id === SNOOZE_UNTIL_DONE_PRESET.id) {
    return shown.find((preset) => preset.id === id);
  }
  const picked = pickSharedSnoozePreset({
    shown: shown.flatMap((preset) =>
      preset.snoozedUntil === null ? [] : [{ ...preset, snoozedUntil: preset.snoozedUntil }],
    ),
    id,
    now: new Date(),
    ...snoozeOptions(timestampFormat, environmentId),
    resolve,
  });
  if (!picked) {
    toastManager.add({
      type: "warning",
      title: resolve(msg("Could not snooze thread")),
      description: resolve(msg("That snooze time has passed. Choose another time.")),
    });
  }
  return picked;
}

function snoozeOptions(timestampFormat: TimestampFormat, environmentId: EnvironmentId) {
  const locale = getFormattingLocale();
  const presets = appAtomRegistry.get(
    serverEnvironment.settingsValueAtom(environmentId),
  )?.snoozePresets;
  return {
    ...(presets ? { presets } : {}),
    formatTime: (date: Date) => formatShortTimestamp(date.toISOString(), timestampFormat, locale),
    locale,
  };
}
