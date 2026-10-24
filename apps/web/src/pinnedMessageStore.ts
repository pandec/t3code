import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

const EMPTY_PINNED_MESSAGE_IDS: ReadonlyArray<string> = [];

interface PinnedMessageStoreState {
  /** Scoped thread key → pinned timeline message ids. Browser-local by design. */
  pinnedMessageIdsByThreadKey: Record<string, ReadonlyArray<string>>;
  togglePinnedMessage: (threadKey: string, messageId: string) => void;
}

export const usePinnedMessageStore = create<PinnedMessageStoreState>()(
  persist(
    (set) => ({
      pinnedMessageIdsByThreadKey: {},
      togglePinnedMessage: (threadKey, messageId) =>
        set(({ pinnedMessageIdsByThreadKey }) => {
          const current = pinnedMessageIdsByThreadKey[threadKey] ?? EMPTY_PINNED_MESSAGE_IDS;
          const next = current.includes(messageId)
            ? current.filter((id) => id !== messageId)
            : [...current, messageId];
          const { [threadKey]: _removed, ...rest } = pinnedMessageIdsByThreadKey;
          return {
            pinnedMessageIdsByThreadKey: next.length > 0 ? { ...rest, [threadKey]: next } : rest,
          };
        }),
    }),
    {
      name: "t3code:pinned-messages:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: ({ pinnedMessageIdsByThreadKey }) => ({ pinnedMessageIdsByThreadKey }),
      // Selectors index into this record, so a malformed stored value must not hydrate.
      merge: (persisted, current) => ({
        ...current,
        pinnedMessageIdsByThreadKey: sanitizePinnedMessageIds(
          (persisted as { pinnedMessageIdsByThreadKey?: unknown } | null)
            ?.pinnedMessageIdsByThreadKey,
        ),
      }),
    },
  ),
);

function sanitizePinnedMessageIds(value: unknown): Record<string, ReadonlyArray<string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: Record<string, ReadonlyArray<string>> = {};
  for (const [threadKey, ids] of Object.entries(value)) {
    if (!Array.isArray(ids)) continue;
    const messageIds = ids.filter((id): id is string => typeof id === "string");
    if (messageIds.length > 0) result[threadKey] = messageIds;
  }
  return result;
}

export function usePinnedMessageIds(threadKey: string): ReadonlyArray<string> {
  return usePinnedMessageStore(
    (state) => state.pinnedMessageIdsByThreadKey[threadKey] ?? EMPTY_PINNED_MESSAGE_IDS,
  );
}

export function useIsMessagePinned(threadKey: string, messageId: string): boolean {
  return usePinnedMessageStore(
    (state) => state.pinnedMessageIdsByThreadKey[threadKey]?.includes(messageId) === true,
  );
}
