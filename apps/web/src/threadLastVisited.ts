/** Session-local history of the two most recently focused server threads. */
import type { KeybindingCommand, ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import type { ShortcutEventLike } from "./keybindings";

export interface ThreadVisitHistory {
  record(ref: ScopedThreadRef | null): void;
  /**
   * The most recent visited thread that is not the focused one. From a
   * tracked thread that is the previous thread; from a draft (or nothing
   * focused) it is the thread the user came from.
   */
  resolveTarget(focusedRef: ScopedThreadRef | null): ScopedThreadRef | null;
}

export function createThreadVisitHistory(): ThreadVisitHistory {
  let current: ScopedThreadRef | null = null;
  let previous: ScopedThreadRef | null = null;
  return {
    record(ref) {
      if (ref === null) return;
      if (current !== null && scopedThreadKey(current) === scopedThreadKey(ref)) return;
      previous = current;
      current = ref;
    },
    resolveTarget(focusedRef) {
      const focusedKey = focusedRef === null ? null : scopedThreadKey(focusedRef);
      for (const candidate of [current, previous]) {
        if (candidate !== null && scopedThreadKey(candidate) !== focusedKey) {
          return candidate;
        }
      }
      return null;
    },
  };
}

export const threadVisitHistory = createThreadVisitHistory();

export interface LastVisitedShortcutEvent extends ShortcutEventLike {
  repeat: boolean;
  defaultPrevented: boolean;
  target: EventTarget | null;
  preventDefault(): void;
  stopPropagation(): void;
}

/**
 * Retained across handler replacement so navigation cannot lose the pending
 * key release before the user lets go of Tab.
 */
export interface LastVisitedPendingRelease {
  key: string | null;
}

export interface LastVisitedThreadShortcutOptions {
  isDesktop: boolean;
  pendingRelease: LastVisitedPendingRelease;
  resolveCommand: (event: LastVisitedShortcutEvent) => KeybindingCommand | null;
  /** An overlay (palette, picker, modal) owns the keyboard: consume, do nothing. */
  isBlocked: () => boolean;
  /** The validated toggle target, or null when there is nothing to open. */
  resolveTarget: () => ScopedThreadRef | null;
  openThread: (ref: ScopedThreadRef) => void;
}

/**
 * Capture-phase handlers for the toggle chord. Once the chord resolves to the
 * command the keydown is always consumed, even when nothing opens: the
 * composer's suggestion list and the terminal must never see a stray Tab.
 * The matching keyup is consumed too, with or without Control still held,
 * because Ghostty reports key releases to Kitty-protocol sessions and would
 * otherwise send an orphan release for a press it never saw.
 */
export function createLastVisitedThreadShortcut(options: LastVisitedThreadShortcutOptions): {
  onKeyDown: (event: LastVisitedShortcutEvent) => void;
  onKeyUp: (event: LastVisitedShortcutEvent) => void;
} {
  const { pendingRelease } = options;
  const releaseKey = (event: LastVisitedShortcutEvent) => event.code || event.key.toLowerCase();
  return {
    onKeyDown: (event) => {
      if (!options.isDesktop) return;
      // A release can be lost while the app is unfocused. A fresh press of
      // that key owns its release, even if it is no longer our shortcut.
      if (!event.repeat && releaseKey(event) === pendingRelease.key) {
        pendingRelease.key = null;
      }
      if (event.defaultPrevented) return;
      if (options.resolveCommand(event) !== "thread.lastVisited") return;
      event.preventDefault();
      event.stopPropagation();
      pendingRelease.key = releaseKey(event);
      if (event.repeat || options.isBlocked()) return;
      const target = options.resolveTarget();
      if (target !== null) {
        options.openThread(target);
      }
    },
    onKeyUp: (event) => {
      if (pendingRelease.key === null || releaseKey(event) !== pendingRelease.key) return;
      pendingRelease.key = null;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
