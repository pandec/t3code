/** Session-local history of the two most recently focused threads and drafts. */
import type { KeybindingCommand } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import type { ShortcutEventLike } from "./keybindings";
import type { ThreadRouteTarget } from "./threadRoutes";

export function threadVisitKey(target: ThreadRouteTarget): string {
  return target.kind === "server" ? scopedThreadKey(target.threadRef) : `draft:${target.draftId}`;
}

/**
 * Maps a remembered entry onto what it can open now: a sent draft becomes
 * its server thread, and a discarded draft or an unavailable thread is null.
 */
export type ThreadVisitResolver = (target: ThreadRouteTarget) => ThreadRouteTarget | null;

export interface ThreadVisitHistory {
  record(target: ThreadRouteTarget | null, resolve?: ThreadVisitResolver): void;
  /** Most recent openable entry other than the focused one. */
  resolveTarget(
    focused: ThreadRouteTarget | null,
    resolve?: ThreadVisitResolver,
  ): ThreadRouteTarget | null;
}

export function createThreadVisitHistory(): ThreadVisitHistory {
  let current: ThreadRouteTarget | null = null;
  let previous: ThreadRouteTarget | null = null;
  return {
    record(target, resolve = (entry) => entry) {
      if (target === null) return;
      const resolvedCurrent = current === null ? null : resolve(current);
      // Sending a draft lands on its new thread: that is the same visit, so
      // it replaces the draft instead of pushing the older entry out.
      if (resolvedCurrent !== null && threadVisitKey(resolvedCurrent) === threadVisitKey(target)) {
        current = target;
        return;
      }
      previous = current;
      current = target;
    },
    resolveTarget(focused, resolve = (entry) => entry) {
      const focusedKey = focused === null ? null : threadVisitKey(focused);
      for (const candidate of [current, previous]) {
        const target = candidate === null ? null : resolve(candidate);
        if (target !== null && threadVisitKey(target) !== focusedKey) {
          return target;
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
  resolveTarget: () => ThreadRouteTarget | null;
  openThread: (target: ThreadRouteTarget) => void;
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
