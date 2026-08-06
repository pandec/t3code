import type { OrchestrationThread } from "@t3tools/contracts";
import * as Option from "effect/Option";

export type EnvironmentThreadStatus = "empty" | "cached" | "synchronizing" | "live" | "deleted";

export interface ThreadOlderMessagesState {
  readonly isLoading: boolean;
  readonly error: string | null;
}

export interface EnvironmentThreadState {
  readonly data: Option.Option<OrchestrationThread>;
  readonly status: EnvironmentThreadStatus;
  readonly error: Option.Option<string>;
  readonly olderMessages: ThreadOlderMessagesState;
}

export const EMPTY_THREAD_OLDER_MESSAGES_STATE: ThreadOlderMessagesState = {
  isLoading: false,
  error: null,
};

export const EMPTY_ENVIRONMENT_THREAD_STATE: EnvironmentThreadState = {
  data: Option.none(),
  status: "empty",
  error: Option.none(),
  olderMessages: EMPTY_THREAD_OLDER_MESSAGES_STATE,
};
