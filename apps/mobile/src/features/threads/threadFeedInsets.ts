export interface ThreadFeedInsetReport {
  readonly listMountKey: string;
  readonly baseline: number;
}

export function shouldReleaseThreadFeedAnchor(input: {
  readonly anchorMessageId: string | null;
  readonly readyAnchorKey: string | undefined;
  readonly readySize: number;
}): boolean {
  return (
    input.anchorMessageId !== null &&
    input.readyAnchorKey === input.anchorMessageId &&
    Number.isFinite(input.readySize) &&
    input.readySize === 0
  );
}

export function resolveThreadFeedInsetBaseline(input: {
  readonly measuredOverlayHeight: number | null;
  readonly estimatedOverlayHeight: number;
  readonly nativeInsetOvercount: number;
}): number {
  const measuredHeight =
    input.measuredOverlayHeight !== null && Number.isFinite(input.measuredOverlayHeight)
      ? input.measuredOverlayHeight
      : null;
  const estimatedHeight = Number.isFinite(input.estimatedOverlayHeight)
    ? input.estimatedOverlayHeight
    : 0;
  const nativeInsetOvercount = Number.isFinite(input.nativeInsetOvercount)
    ? input.nativeInsetOvercount
    : 0;
  return Math.max(0, (measuredHeight ?? estimatedHeight) - nativeInsetOvercount);
}

/**
 * The keyboard integration owns the list's content-inset override, writing
 * `min(viewport, max(anchoredBlankSpace, keyboard + composer))` and re-emitting only on change. A
 * JS write of the closed-keyboard baseline is safe only when nothing larger is in play, or it
 * replaces the anchored end space and the integration never corrects it.
 */
export function resolveThreadFeedInsetReport(input: {
  readonly listMountKey: string;
  readonly baseline: number;
  readonly keyboardVisible: boolean;
  readonly anchoredEndSpaceActive: boolean;
  readonly lastReported: ThreadFeedInsetReport | null;
}): ThreadFeedInsetReport | null {
  if (input.keyboardVisible) {
    return null;
  }

  const lastReported = input.lastReported;
  if (lastReported !== null && lastReported.listMountKey === input.listMountKey) {
    // Same list instance, so its override is already primed. Only a composer
    // height change is worth re-reporting, and only while the anchored end
    // space is not the larger of the two — when the composer grows past it the
    // integration's own total changes and it re-emits.
    if (lastReported.baseline === input.baseline || input.anchoredEndSpaceActive) {
      return null;
    }
  }

  return {
    listMountKey: input.listMountKey,
    baseline: input.baseline,
  };
}
