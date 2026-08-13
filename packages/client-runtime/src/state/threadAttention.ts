export interface ThreadAttentionInput {
  readonly isReady: boolean;
  /** Ready-thread signals only: plan-ready prompt or unseen completion. */
  readonly readyAttentionSignal: boolean;
  readonly wokeAt: string | null;
  readonly lastVisitedAt?: string | undefined;
}

export function hasUnseenWake(input: {
  readonly wokeAt: string | null;
  readonly lastVisitedAt?: string | undefined;
}): boolean {
  if (input.wokeAt === null) return false;
  const wokeAt = Date.parse(input.wokeAt);
  if (Number.isNaN(wokeAt)) return false;
  if (input.lastVisitedAt === undefined) return true;

  const lastVisitedAt = Date.parse(input.lastVisitedAt);
  return Number.isNaN(lastVisitedAt) || wokeAt > lastVisitedAt;
}

/**
 * A ready thread's unseen wake suppresses attention because the wake indicator
 * already carries that signal. Raising both inverted mobile's polarity before
 * 4a275a2fa; keeping this shared prevents web and mobile from diverging again.
 */
export function isThreadAttention(input: ThreadAttentionInput): boolean {
  if (!input.isReady) return true;
  if (
    hasUnseenWake({
      wokeAt: input.wokeAt,
      ...(input.lastVisitedAt === undefined ? {} : { lastVisitedAt: input.lastVisitedAt }),
    })
  ) {
    return false;
  }
  return input.readyAttentionSignal;
}

export function passesAttentionFilter(input: {
  readonly memberKeys: ReadonlySet<string> | null;
  readonly threadKey: string;
  readonly pinned: boolean;
  readonly alwaysShowPinned: boolean;
}): boolean {
  return (
    input.memberKeys === null ||
    input.memberKeys.has(input.threadKey) ||
    (input.alwaysShowPinned && input.pinned)
  );
}

export interface AttentionFilterState {
  readonly memberKeys: ReadonlySet<string>;
  readonly knownKeys: ReadonlySet<string>;
}

/**
 * Captures sticky attention membership. A member stays visible while the
 * filter is on even after its status clears; toggling off and back on takes a
 * fresh snapshot.
 */
export function createAttentionFilter(input: {
  readonly initialMemberKeys: readonly string[];
  readonly keys: readonly string[];
}): AttentionFilterState {
  return {
    memberKeys: new Set(input.initialMemberKeys),
    knownKeys: new Set(input.keys),
  };
}

/**
 * When no keys are new, the returned sets are the input sets by identity.
 * Callers that pass a temporary state wrapper must compare `memberKeys` and
 * `knownKeys`; the returned wrapper object's identity is not the contract.
 */
export function admitNewAttentionKeys(
  state: AttentionFilterState,
  keys: readonly string[],
): AttentionFilterState {
  let knownKeys: Set<string> | null = null;
  let memberKeys: Set<string> | null = null;

  for (const key of keys) {
    if (state.knownKeys.has(key)) continue;

    knownKeys ??= new Set(state.knownKeys);
    memberKeys ??= new Set(state.memberKeys);
    knownKeys.add(key);
    // Admission is based on first appearance after the captured baseline, not
    // createdAt: connected environments have independent clocks, so comparing
    // their timestamps with the device clock can reject a genuine new thread.
    memberKeys.add(key);
  }

  if (knownKeys === null || memberKeys === null) return state;
  return { knownKeys, memberKeys };
}
