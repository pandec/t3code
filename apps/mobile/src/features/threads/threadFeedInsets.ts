export interface ThreadFeedInsetReport {
  readonly listMountKey: string;
  readonly baseline: number;
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
 * Decides whether the closed-keyboard composer baseline should be pushed into
 * the list's imperative content-inset override.
 *
 * The keyboard integration owns that override the rest of the time: it writes
 * `min(viewport, max(anchoredBlankSpace, keyboard + composer))` and only
 * re-emits when that total changes. So a JS write is only safe when nothing
 * larger is in play — otherwise it silently replaces the anchored end space
 * with the bare composer height and the integration never corrects it.
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
