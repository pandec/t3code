import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { LATEST_DATE_MS, type MuseSubscriptionUsage } from "./protocol.ts";

const MuseUsageWindow = Schema.Struct({
  usedPercent: Schema.Finite,
  resetsAtMs: Schema.optional(Schema.Finite),
  windowDurationMins: Schema.optional(Schema.Finite),
});
const MuseUsageOutput = Schema.Struct({
  allowance: Schema.NullOr(
    Schema.Struct({
      window: Schema.optional(Schema.NullOr(MuseUsageWindow)),
      weekly: Schema.optional(Schema.NullOr(MuseUsageWindow)),
    }),
  ),
  reason: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeMuseUsageOutput = Schema.decodeUnknownOption(Schema.fromJsonString(MuseUsageOutput));

const UNSUPPORTED_ALLOWANCE_REASONS: Record<string, string> = {
  api_key: "Muse Code is signed in with an API key, which has no subscription allowance.",
  no_allowance: "This Muse Code account has no subscription allowance.",
};

/** Translate `muse usage --json` output; any unreadable answer is a failed probe. */
export function museUsageOutputToLimits(
  stdout: string,
  checkedAt: string,
): ServerProviderUsageLimits {
  const probeFailed = makeUnavailableUsageLimits({
    checkedAt,
    reason: "probeFailed",
    message: "Muse Code could not read usage limits.",
  });
  const decoded = decodeMuseUsageOutput(stdout.trim());
  if (Option.isNone(decoded)) return probeFailed;
  const { allowance, reason } = decoded.value;
  if (allowance === null) {
    const message = reason ? UNSUPPORTED_ALLOWANCE_REASONS[reason] : undefined;
    return message === undefined
      ? probeFailed
      : makeUnavailableUsageLimits({ checkedAt, reason: "unsupported", message });
  }
  const toWindow = (
    window: typeof MuseUsageWindow.Type | null | undefined,
    base: Pick<ServerProviderUsageWindow, "id" | "kind" | "label">,
  ): ServerProviderUsageWindow[] => {
    if (!window) return [];
    const resetsAtMs = window.resetsAtMs;
    const durationMins = window.windowDurationMins;
    return [
      {
        ...base,
        // Meta reports over-quota usage verbatim, above 100.
        usedPercent: clampPercent(window.usedPercent),
        ...(resetsAtMs !== undefined && resetsAtMs > 0 && resetsAtMs <= LATEST_DATE_MS
          ? { resetsAt: DateTime.formatIso(DateTime.makeUnsafe(resetsAtMs)) }
          : {}),
        ...(durationMins !== undefined && durationMins > 0
          ? { windowDurationMins: Math.round(durationMins) }
          : {}),
      },
    ];
  };
  const windows = [
    ...toWindow(allowance.window, { id: "muse-window", kind: "session", label: "Session" }),
    ...toWindow(allowance.weekly, { id: "muse-weekly", kind: "weekly", label: "Weekly" }),
  ];
  return windows.length > 0 ? makeUsageLimits({ checkedAt, windows }) : probeFailed;
}

/** Credential proxies may omit error.quota from 429 refusals; inspect text too. */
export function isMuseUsageLimitFailure(message: string | undefined): boolean {
  return message !== undefined && /\b429\b/.test(message) && /quota|usage limit/i.test(message);
}

const NAMED_RESET =
  /\bresets at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/i;

/** Resume only after all exhausted windows reset; use the latest future reset from quota, refusal, or usage. */
export function museUsageLimitResetAt(
  usage: MuseSubscriptionUsage | undefined,
  nowMs: number,
  refusal?: {
    readonly quota?: { readonly resetsAtMs: number } | undefined;
    readonly message?: string | undefined;
  },
): string | null {
  const named = refusal?.message?.match(NAMED_RESET)?.[1];
  const resets = [
    ...[usage?.window, usage?.weekly].map((window) =>
      window && window.usedPercent >= 100 ? window.resetsAtMs : undefined,
    ),
    refusal?.quota?.resetsAtMs,
    named === undefined ? undefined : Date.parse(named),
  ].filter(
    (ms): ms is number =>
      ms !== undefined && Number.isFinite(ms) && ms > nowMs && ms <= LATEST_DATE_MS,
  );
  return resets.length > 0 ? DateTime.formatIso(DateTime.makeUnsafe(Math.max(...resets))) : null;
}
