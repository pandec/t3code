import type { ThreadListV2Status } from "./threadListV2";

/**
 * Mirrors web's recede rule: background work fades so rows that need a
 * human (approval, input, failure, unseen completion) stand out. An unseen
 * completion cannot pull a still-working thread forward. Fork: Monitoring
 * (watch loops alone) recedes like Working.
 */
export function shouldRecedeThreadRow(input: {
  readonly status: ThreadListV2Status;
  readonly selected: boolean;
}): boolean {
  return (
    !input.selected &&
    (input.status === "working" || input.status === "monitoring" || input.status === "waiting")
  );
}
