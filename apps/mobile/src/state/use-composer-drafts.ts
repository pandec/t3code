import { useAtomValue } from "@effect/atom-react";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type EnvironmentId,
  type ModelSelection,
  MessageInputOrigin,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import { useEffect } from "react";
import { Atom } from "effect/unstable/reactivity";

import type { DraftComposerImageAttachment } from "../lib/composerImages";
import { SerializedAsyncQueue } from "../lib/serialized-async-queue";
import { appAtomRegistry } from "./atom-registry";
import {
  ComposerDraftBatchPersistenceError,
  ComposerDraftPersistenceError,
  decodePersistedComposerDrafts,
  hydratePersistedComposerDraftKey,
  loadPersistedComposerDraftState,
  persistComposerDraftKeys,
} from "./composer-draft-persistence";

export { ComposerDraftPersistenceError, decodePersistedComposerDrafts };

const PERSIST_DEBOUNCE_MS = 1_000;
const PERSIST_MAX_DELAY_MS = 5_000;
const PERSIST_RETRY_MAX_ATTEMPTS = 5;
const PERSIST_RETRY_MAX_DELAY_MS = 30_000;

export interface ComposerDraft {
  readonly text: string;
  readonly inputOrigin?: MessageInputOrigin;
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly importedShareIds?: ReadonlyArray<string>;
  readonly modelSelection?: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly workspaceSelection?: ComposerDraftWorkspaceSelection;
}

export interface ComposerDraftContent {
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly sourceShareId?: string;
}

export interface ComposerDraftWorkspaceSelection {
  /**
   * Only set once the user explicitly picks a mode. Left undefined while the
   * draft is still following the resolved default (project setting → t3.json
   * → global), so controls that edit worktree metadata never freeze a
   * provisional or implicit default into the draft.
   */
  readonly mode?: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly startFromOrigin?: boolean;
}

export type ComposerDraftSettingsUpdate = Pick<
  ComposerDraft,
  "modelSelection" | "runtimeMode" | "interactionMode" | "workspaceSelection"
>;

const EMPTY_DRAFT: ComposerDraft = {
  text: "",
  attachments: [],
};

export const composerDraftsAtom = Atom.make<Record<string, ComposerDraft>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:composer-drafts"),
);

let loadPromise: Promise<void> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistMaxDelayTimer: ReturnType<typeof setTimeout> | null = null;
let hydrationComplete = false;
const persistRetryAttempts = new Map<string, number>();
const draftKeysMutatedBeforeHydration = new Set<string>();
const partialDraftKeys = new Set<string>();
const partialVisibleAttachmentIds = new Map<string, ReadonlySet<string>>();
const persistenceQueue = new SerializedAsyncQueue();

function normalizeDraft(draft: ComposerDraft | undefined): ComposerDraft {
  if (!draft) {
    return EMPTY_DRAFT;
  }
  return {
    ...draft,
    text: draft.text,
    attachments: draft.attachments,
  };
}

export function getComposerDraftSnapshot(draftKey: string): ComposerDraft {
  return normalizeDraft(appAtomRegistry.get(composerDraftsAtom)[draftKey]);
}

export function isComposerDraftEmpty(draft: ComposerDraft): boolean {
  return isEmptyDraft(draft);
}

function isEmptyDraft(draft: ComposerDraft): boolean {
  return (
    draft.text.length === 0 &&
    draft.inputOrigin === undefined &&
    draft.attachments.length === 0 &&
    draft.modelSelection === undefined &&
    draft.runtimeMode === undefined &&
    draft.interactionMode === undefined &&
    draft.workspaceSelection === undefined
  );
}

const pendingDraftKeys = new Set<string>();
const pendingDiscardPartialKeys = new Set<string>();
let pendingAttachmentSweep = false;

function takePendingPersistence(): {
  readonly draftKeys: ReadonlySet<string>;
  readonly discardPartialKeys: ReadonlySet<string>;
  readonly sweepAttachments: boolean;
} {
  const draftKeys = new Set(pendingDraftKeys);
  const discardPartialKeys = new Set(pendingDiscardPartialKeys);
  const sweepAttachments = pendingAttachmentSweep;
  pendingDraftKeys.clear();
  pendingDiscardPartialKeys.clear();
  pendingAttachmentSweep = false;
  return { draftKeys, discardPartialKeys, sweepAttachments };
}

function mergeRecoveredAttachments(
  recovered: ReadonlyArray<DraftComposerImageAttachment>,
  latest: ReadonlyArray<DraftComposerImageAttachment>,
  previouslyVisibleIds: ReadonlySet<string>,
): ReadonlyArray<DraftComposerImageAttachment> {
  const visibleIds = new Set<string>();
  const visible = latest
    .filter((attachment) => {
      if (visibleIds.has(attachment.id)) {
        return false;
      }
      visibleIds.add(attachment.id);
      return true;
    })
    .slice(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS);
  const retainedRecovered = recovered.filter(
    (attachment) => !visibleIds.has(attachment.id) && !previouslyVisibleIds.has(attachment.id),
  );
  return [
    ...retainedRecovered.slice(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS - visible.length),
    ...visible,
  ];
}

async function persistDraftKeysNow(
  drafts: Record<string, ComposerDraft>,
  draftKeys: ReadonlySet<string>,
  options?: {
    readonly verify?: boolean;
    readonly sweepAttachments?: boolean;
    readonly discardPartialKeys?: ReadonlySet<string>;
  },
): Promise<void> {
  const draftsToPersist = { ...drafts };
  const readyDraftKeys = new Set<string>();
  const failures = new Map<string, unknown>();

  for (const draftKey of draftKeys) {
    if (!partialDraftKeys.has(draftKey) || options?.discardPartialKeys?.has(draftKey)) {
      if (options?.discardPartialKeys?.has(draftKey)) {
        partialDraftKeys.delete(draftKey);
        partialVisibleAttachmentIds.delete(draftKey);
      }
      readyDraftKeys.add(draftKey);
      continue;
    }
    try {
      const hydrated = await hydratePersistedComposerDraftKey(draftKey);
      if (hydrated.state === "unavailable") {
        failures.set(draftKey, new Error("Persisted composer attachments remain unavailable."));
        continue;
      }
      partialDraftKeys.delete(draftKey);
      readyDraftKeys.add(draftKey);
      if (hydrated.state === "ready") {
        const current = appAtomRegistry.get(composerDraftsAtom);
        const latest = current[draftKey];
        if (latest) {
          const merged = {
            ...latest,
            attachments: mergeRecoveredAttachments(
              hydrated.draft.attachments,
              latest.attachments,
              partialVisibleAttachmentIds.get(draftKey) ?? new Set(),
            ),
          };
          const next = { ...current, [draftKey]: merged };
          appAtomRegistry.set(composerDraftsAtom, next);
          draftsToPersist[draftKey] = merged;
        }
      }
      partialVisibleAttachmentIds.delete(draftKey);
    } catch (error) {
      failures.set(draftKey, error);
    }
  }

  if (readyDraftKeys.size > 0) {
    try {
      await persistComposerDraftKeys(draftsToPersist, readyDraftKeys, options);
    } catch (error) {
      for (const draftKey of failedDraftKeys(error, readyDraftKeys)) {
        failures.set(draftKey, error);
      }
    }
  }

  for (const draftKey of readyDraftKeys) {
    if (!failures.has(draftKey)) {
      partialDraftKeys.delete(draftKey);
    }
  }
  if (failures.size > 0) {
    throw new ComposerDraftBatchPersistenceError(failures);
  }
}

async function persistDraftKeys(
  drafts: Record<string, ComposerDraft>,
  draftKeys: ReadonlySet<string>,
  options?: {
    readonly verify?: boolean;
    readonly sweepAttachments?: boolean;
    readonly discardPartial?: boolean;
  },
): Promise<void> {
  try {
    await persistenceQueue.run(() =>
      persistDraftKeysNow(drafts, draftKeys, {
        ...options,
        discardPartialKeys: options?.discardPartial === true ? draftKeys : new Set<string>(),
      }),
    );
    for (const draftKey of draftKeys) {
      persistRetryAttempts.delete(draftKey);
    }
  } catch (error) {
    const failed = failedDraftKeys(error, draftKeys);
    for (const draftKey of draftKeys) {
      if (!failed.has(draftKey)) {
        persistRetryAttempts.delete(draftKey);
      }
    }
    throw error;
  }
}

function failedDraftKeys(
  error: unknown,
  attemptedDraftKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  return error instanceof ComposerDraftBatchPersistenceError
    ? error.failedDraftKeys
    : attemptedDraftKeys;
}

function retryDelay(draftKeys: ReadonlySet<string>): number {
  let delay = PERSIST_RETRY_MAX_DELAY_MS;
  for (const draftKey of draftKeys) {
    const attempts = persistRetryAttempts.get(draftKey) ?? 1;
    const keyDelay =
      attempts >= PERSIST_RETRY_MAX_ATTEMPTS
        ? PERSIST_RETRY_MAX_DELAY_MS
        : PERSIST_DEBOUNCE_MS * 2 ** (attempts - 1);
    delay = Math.min(delay, keyDelay);
  }
  return delay;
}

function requeueFailedDrafts(
  draftKeys: ReadonlySet<string>,
  sweepAttachments: boolean,
  discardPartialKeys: ReadonlySet<string> = new Set(),
): void {
  for (const draftKey of draftKeys) {
    pendingDraftKeys.add(draftKey);
    if (discardPartialKeys.has(draftKey)) {
      pendingDiscardPartialKeys.add(draftKey);
    }
    persistRetryAttempts.set(draftKey, (persistRetryAttempts.get(draftKey) ?? 0) + 1);
  }
  pendingAttachmentSweep ||= sweepAttachments && draftKeys.size > 0;
  schedulePersistenceRetry();
}

async function savePendingComposerDrafts(): Promise<void> {
  const pending = takePendingPersistence();
  if (pending.draftKeys.size === 0 && !pending.sweepAttachments) {
    await persistenceQueue.run(async () => undefined);
    return;
  }
  try {
    await persistenceQueue.run(() =>
      persistDraftKeysNow(appAtomRegistry.get(composerDraftsAtom), pending.draftKeys, {
        sweepAttachments: pending.sweepAttachments,
        discardPartialKeys: pending.discardPartialKeys,
      }),
    );
    for (const draftKey of pending.draftKeys) {
      persistRetryAttempts.delete(draftKey);
    }
  } catch (error) {
    const failed = failedDraftKeys(error, pending.draftKeys);
    for (const draftKey of pending.draftKeys) {
      if (!failed.has(draftKey)) {
        persistRetryAttempts.delete(draftKey);
      }
    }
    requeueFailedDrafts(failed, pending.sweepAttachments, pending.discardPartialKeys);
    console.warn("[composer-drafts] failed to persist drafts", error);
    // Draft persistence is best-effort; in-memory drafts still keep working.
  }
}

function clearPersistenceTimers(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (persistMaxDelayTimer !== null) {
    clearTimeout(persistMaxDelayTimer);
    persistMaxDelayTimer = null;
  }
}

function startPendingPersistence(): void {
  clearPersistenceTimers();
  void savePendingComposerDrafts();
}

function ensurePersistenceTimers(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
  }
  persistTimer = setTimeout(startPendingPersistence, PERSIST_DEBOUNCE_MS);
  persistMaxDelayTimer ??= setTimeout(startPendingPersistence, PERSIST_MAX_DELAY_MS);
}

function schedulePersistenceRetry(): void {
  clearPersistenceTimers();
  if (pendingDraftKeys.size === 0) {
    return;
  }
  persistTimer = setTimeout(startPendingPersistence, retryDelay(pendingDraftKeys));
}

export async function flushComposerDrafts(): Promise<void> {
  clearPersistenceTimers();
  await savePendingComposerDrafts();
  clearPersistenceTimers();
  if (pendingDraftKeys.size > 0 || pendingAttachmentSweep) {
    await savePendingComposerDrafts();
  }
}

function schedulePersistComposerDraft(
  draftKey: string,
  options?: {
    readonly sweepAttachments?: boolean;
    readonly immediate?: boolean;
    readonly discardPartial?: boolean;
  },
): void {
  pendingDraftKeys.add(draftKey);
  if (options?.discardPartial === true) {
    pendingDiscardPartialKeys.add(draftKey);
  }
  pendingAttachmentSweep ||= options?.sweepAttachments === true;
  persistRetryAttempts.delete(draftKey);
  if (options?.immediate === true) {
    startPendingPersistence();
    return;
  }
  ensurePersistenceTimers();
}

function removePendingDraftKey(draftKey: string): void {
  pendingDraftKeys.delete(draftKey);
  pendingDiscardPartialKeys.delete(draftKey);
}

function requeueDraftPersistence(
  draftKey: string,
  options?: { readonly sweepAttachments?: boolean; readonly discardPartial?: boolean },
): void {
  const draftKeys = new Set([draftKey]);
  requeueFailedDrafts(
    draftKeys,
    options?.sweepAttachments === true,
    options?.discardPartial === true ? draftKeys : new Set(),
  );
}

/** Resets module persistence state between isolated unit tests. */
export function resetComposerDraftPersistenceForTests(): void {
  clearPersistenceTimers();
  loadPromise = null;
  hydrationComplete = false;
  persistRetryAttempts.clear();
  draftKeysMutatedBeforeHydration.clear();
  partialDraftKeys.clear();
  partialVisibleAttachmentIds.clear();
  pendingDraftKeys.clear();
  pendingDiscardPartialKeys.clear();
  pendingAttachmentSweep = false;
}

export function mergeHydratedComposerDrafts(
  persistedDrafts: Record<string, ComposerDraft>,
  currentDrafts: Record<string, ComposerDraft>,
  mutatedDraftKeys: ReadonlySet<string>,
): Record<string, ComposerDraft> {
  const retainedPersistedDrafts = Object.fromEntries(
    Object.entries(persistedDrafts).filter(([draftKey]) => !mutatedDraftKeys.has(draftKey)),
  );
  return {
    ...retainedPersistedDrafts,
    ...currentDrafts,
  };
}

export function ensureComposerDraftsLoaded(): void {
  if (loadPromise !== null) {
    return;
  }
  loadPromise = persistenceQueue
    .run(() => loadPersistedComposerDraftState())
    .then((persisted) => {
      partialDraftKeys.clear();
      partialVisibleAttachmentIds.clear();
      for (const draftKey of persisted.unavailableDraftKeys) {
        partialDraftKeys.add(draftKey);
        partialVisibleAttachmentIds.set(
          draftKey,
          new Set(persisted.drafts[draftKey]?.attachments.map((attachment) => attachment.id) ?? []),
        );
      }
      const current = appAtomRegistry.get(composerDraftsAtom);
      appAtomRegistry.set(
        composerDraftsAtom,
        mergeHydratedComposerDrafts(persisted.drafts, current, draftKeysMutatedBeforeHydration),
      );
    })
    .catch((cause) => {
      console.warn(
        "[composer-drafts] failed to hydrate drafts",
        new ComposerDraftPersistenceError({
          operation: "hydrate",
          directory: "composer-drafts",
          fileName: "*",
          cause,
        }),
      );
      // Draft loading is best-effort; in-memory drafts still keep working.
    })
    .finally(() => {
      hydrationComplete = true;
      draftKeysMutatedBeforeHydration.clear();
    });
}

function updateComposerDrafts(
  draftKey: string,
  update: (current: Record<string, ComposerDraft>) => Record<string, ComposerDraft>,
  options?: {
    readonly sweepAttachments?: boolean;
    readonly immediate?: boolean;
    readonly discardPartial?: boolean;
    readonly discardPartialOnlyWhenChanged?: boolean;
  },
): void {
  const current = appAtomRegistry.get(composerDraftsAtom);
  const next = update(current);
  if (next === current) {
    if (!hydrationComplete) {
      draftKeysMutatedBeforeHydration.add(draftKey);
      schedulePersistComposerDraft(draftKey, {
        ...options,
        discardPartial: options?.discardPartial === true && !options.discardPartialOnlyWhenChanged,
      });
    }
    return;
  }
  appAtomRegistry.set(composerDraftsAtom, next);
  if (!hydrationComplete) {
    draftKeysMutatedBeforeHydration.add(draftKey);
  }
  schedulePersistComposerDraft(draftKey, options);
}

export function setComposerDraftText(
  draftKey: string,
  value: string,
  inputOrigin?: MessageInputOrigin,
): void {
  updateComposerDrafts(draftKey, (current) => {
    const existing = normalizeDraft(current[draftKey]);
    const { inputOrigin: existingInputOrigin, ...existingWithoutInputOrigin } = existing;
    const nextInputOrigin = value.length === 0 ? undefined : (inputOrigin ?? existingInputOrigin);
    const draft = {
      ...existingWithoutInputOrigin,
      text: value,
      ...(nextInputOrigin !== undefined ? { inputOrigin: nextInputOrigin } : {}),
    };
    if (isEmptyDraft(draft)) {
      const next = { ...current };
      delete next[draftKey];
      return next;
    }
    return {
      ...current,
      [draftKey]: draft,
    };
  });
}

/**
 * Separator rule for appending a block of text to an existing draft. Exported so
 * a caller can predict the exact result and verify its append actually landed
 * before it destroys the only other copy of the content.
 */
export function appendedComposerDraftText(existing: string, addition: string): string {
  if (addition.length === 0) {
    return existing;
  }
  const separator = existing.trim().length > 0 && !existing.endsWith("\n") ? "\n\n" : "";
  return `${existing}${separator}${addition}`;
}

export interface DurableComposerDraftAppend {
  readonly before: ComposerDraft;
  readonly appended: ComposerDraft;
  readonly status: "committed" | "persist-failed";
}

/**
 * Publishes an append to the live draft and acknowledges it only after the
 * destination file contains the same snapshot. Unlike normal typing, this
 * write is not debounced or best-effort because callers may destroy a durable
 * source as soon as it succeeds.
 */
export async function appendComposerDraftContentDurably(
  draftKey: string,
  input: {
    readonly text: string;
    readonly attachments: ReadonlyArray<DraftComposerImageAttachment>;
  },
): Promise<DurableComposerDraftAppend> {
  ensureComposerDraftsLoaded();
  if (loadPromise !== null) {
    await loadPromise;
  }
  const current = appAtomRegistry.get(composerDraftsAtom);
  const before = normalizeDraft(current[draftKey]);
  const appended: ComposerDraft = {
    ...before,
    text: appendedComposerDraftText(before.text, input.text),
    attachments: [...before.attachments, ...input.attachments],
  };
  const next = {
    ...current,
    [draftKey]: appended,
  };
  appAtomRegistry.set(composerDraftsAtom, next);

  removePendingDraftKey(draftKey);
  try {
    await persistDraftKeys(next, new Set([draftKey]), { verify: true });
    return { before, appended, status: "committed" };
  } catch (error) {
    requeueDraftPersistence(draftKey);
    console.warn("[composer-drafts] failed to durably append queued message", error);
    return { before, appended, status: "persist-failed" };
  }
}

/**
 * Compensates one append without restoring a stale whole-draft snapshot.
 * Text/origin are restored only while the appended text is untouched; exact
 * attachment objects introduced by the append are removed from the latest
 * array so later user additions and removals survive.
 */
export interface DurableComposerDraftRevert {
  readonly fullyReverted: boolean;
  readonly persisted: boolean;
}

export async function revertComposerDraftAppend(
  draftKey: string,
  transaction: Pick<DurableComposerDraftAppend, "before" | "appended">,
): Promise<DurableComposerDraftRevert> {
  let fullyReverted = true;
  updateComposerDrafts(draftKey, (current) => {
    const latest = normalizeDraft(current[draftKey]);
    const appendedAttachments = transaction.appended.attachments.slice(
      transaction.before.attachments.length,
    );
    const attachments = [...latest.attachments];
    for (let index = appendedAttachments.length - 1; index >= 0; index -= 1) {
      const attachment = appendedAttachments[index];
      const currentIndex = attachments.lastIndexOf(attachment);
      if (currentIndex >= 0) {
        attachments.splice(currentIndex, 1);
      }
    }

    const canRestoreText = latest.text === transaction.appended.text;
    if (!canRestoreText) {
      fullyReverted = false;
    }
    const { inputOrigin: _latestInputOrigin, ...latestWithoutInputOrigin } = latest;
    const draft: ComposerDraft = {
      ...latestWithoutInputOrigin,
      text: canRestoreText ? transaction.before.text : latest.text,
      attachments,
      ...(canRestoreText && transaction.before.inputOrigin !== undefined
        ? { inputOrigin: transaction.before.inputOrigin }
        : !canRestoreText && latest.inputOrigin !== undefined
          ? { inputOrigin: latest.inputOrigin }
          : {}),
    };
    if (isEmptyDraft(draft)) {
      const next = { ...current };
      delete next[draftKey];
      return next;
    }
    return {
      ...current,
      [draftKey]: draft,
    };
  });
  removePendingDraftKey(draftKey);
  try {
    await persistDraftKeys(appAtomRegistry.get(composerDraftsAtom), new Set([draftKey]), {
      verify: true,
      sweepAttachments: true,
    });
    return { fullyReverted, persisted: true };
  } catch (error) {
    requeueDraftPersistence(draftKey, { sweepAttachments: true });
    console.warn("[composer-drafts] failed to durably revert queued message append", error);
    return { fullyReverted, persisted: false };
  }
}

export function composerDraftStillContainsAppend(
  latest: ComposerDraft,
  transaction: Pick<DurableComposerDraftAppend, "before" | "appended">,
): boolean {
  if (latest.text !== transaction.appended.text) {
    return false;
  }
  const appendedAttachments = transaction.appended.attachments.slice(
    transaction.before.attachments.length,
  );
  const remaining = [...latest.attachments];
  for (const attachment of appendedAttachments) {
    const index = remaining.findIndex(
      (candidate) =>
        candidate.id === attachment.id &&
        candidate.name === attachment.name &&
        candidate.mimeType === attachment.mimeType &&
        candidate.sizeBytes === attachment.sizeBytes &&
        candidate.dataUrl === attachment.dataUrl,
    );
    if (index < 0) {
      return false;
    }
    remaining.splice(index, 1);
  }
  return true;
}

export function appendComposerDraftText(draftKey: string, value: string): void {
  updateComposerDrafts(draftKey, (current) => {
    const existing = normalizeDraft(current[draftKey]);
    return {
      ...current,
      [draftKey]: {
        ...existing,
        text: `${existing.text}${value}`,
      },
    };
  });
}

export function appendComposerDraftAttachments(
  draftKey: string,
  attachments: ReadonlyArray<DraftComposerImageAttachment>,
): void {
  if (attachments.length === 0) {
    return;
  }
  updateComposerDrafts(draftKey, (current) => {
    const existing = normalizeDraft(current[draftKey]);
    return {
      ...current,
      [draftKey]: {
        ...existing,
        attachments: [...existing.attachments, ...attachments],
      },
    };
  });
}

export function replaceComposerDraftAttachments(
  draftKey: string,
  attachments: ReadonlyArray<DraftComposerImageAttachment>,
): void {
  updateComposerDrafts(
    draftKey,
    (current) => {
      const draft = {
        ...normalizeDraft(current[draftKey]),
        attachments,
      };
      if (isEmptyDraft(draft)) {
        const next = { ...current };
        delete next[draftKey];
        return next;
      }
      return {
        ...current,
        [draftKey]: draft,
      };
    },
    { sweepAttachments: true },
  );
}

export function removeComposerDraftAttachment(draftKey: string, imageId: string): void {
  updateComposerDrafts(
    draftKey,
    (current) => {
      const existing = normalizeDraft(current[draftKey]);
      const draft = {
        ...existing,
        attachments: existing.attachments.filter((image) => image.id !== imageId),
      };
      if (isEmptyDraft(draft)) {
        const next = { ...current };
        delete next[draftKey];
        return next;
      }
      return {
        ...current,
        [draftKey]: draft,
      };
    },
    { sweepAttachments: true },
  );
}

export function updateComposerDraftSettings(
  draftKey: string,
  settings: Partial<ComposerDraftSettingsUpdate>,
): void {
  updateComposerDrafts(draftKey, (current) => {
    const draft = {
      ...normalizeDraft(current[draftKey]),
      ...settings,
    };
    if (isEmptyDraft(draft)) {
      const next = { ...current };
      delete next[draftKey];
      return next;
    }
    return {
      ...current,
      [draftKey]: draft,
    };
  });
}

export function clearComposerDraftContentState(
  current: Record<string, ComposerDraft>,
  draftKey: string,
  options?: { readonly clearWorkspaceSelection?: boolean },
): Record<string, ComposerDraft> {
  const existing = current[draftKey];
  if (!existing) {
    return current;
  }
  const {
    importedShareIds: _importedShareIds,
    inputOrigin: _inputOrigin,
    workspaceSelection,
    ...retained
  } = existing;
  const draft = {
    ...retained,
    ...(options?.clearWorkspaceSelection || workspaceSelection === undefined
      ? {}
      : { workspaceSelection }),
    text: "",
    attachments: [],
  };
  if (isEmptyDraft(draft)) {
    const next = { ...current };
    delete next[draftKey];
    return next;
  }
  return {
    ...current,
    [draftKey]: draft,
  };
}

export function clearComposerDraftContentIfUnchangedState(
  current: Record<string, ComposerDraft>,
  draftKey: string,
  expected: Pick<ComposerDraft, "text" | "attachments">,
): Record<string, ComposerDraft> {
  const existing = current[draftKey];
  if (
    !existing ||
    existing.text !== expected.text ||
    existing.attachments !== expected.attachments
  ) {
    return current;
  }
  return clearComposerDraftContentState(current, draftKey);
}

export function restoreComposerDraftSnapshotState(
  current: Record<string, ComposerDraft>,
  draftKey: string,
  snapshot: ComposerDraft,
): Record<string, ComposerDraft> {
  const next = { ...current };
  if (isEmptyDraft(snapshot)) {
    delete next[draftKey];
  } else {
    next[draftKey] = snapshot;
  }
  return next;
}

export function copyComposerDraftContentState(
  current: Record<string, ComposerDraft>,
  sourceDraftKey: string,
  targetDraftKey: string,
): Record<string, ComposerDraft> {
  if (sourceDraftKey === targetDraftKey) {
    return current;
  }
  const source = normalizeDraft(current[sourceDraftKey]);
  const target = normalizeDraft(current[targetDraftKey]);
  const sourceHasContent =
    source.text.length > 0 ||
    source.attachments.length > 0 ||
    (source.importedShareIds?.length ?? 0) > 0;
  const targetHasContent =
    target.text.length > 0 ||
    target.attachments.length > 0 ||
    (target.importedShareIds?.length ?? 0) > 0;
  if (!sourceHasContent || targetHasContent) {
    return current;
  }
  return {
    ...current,
    [targetDraftKey]: {
      ...target,
      text: source.text,
      attachments: source.attachments,
      ...(source.importedShareIds ? { importedShareIds: source.importedShareIds } : {}),
    },
  };
}

export async function copyComposerDraftContentIfEmpty(
  sourceDraftKey: string,
  targetDraftKey: string,
): Promise<void> {
  ensureComposerDraftsLoaded();
  if (loadPromise !== null) {
    await loadPromise;
  }
  updateComposerDrafts(targetDraftKey, (current) =>
    copyComposerDraftContentState(current, sourceDraftKey, targetDraftKey),
  );
}

function mergeComposerDraftText(existing: string, incoming: string): string {
  if (incoming.length === 0) {
    return existing;
  }
  if (existing.length === 0) {
    return incoming;
  }
  // Import retries are possible after an interrupted native handoff. Keep the
  // operation idempotent when the same shared text is already present.
  if (existing === incoming || existing.endsWith(`\n\n${incoming}`)) {
    return existing;
  }
  return `${existing}\n\n${incoming}`;
}

export function mergeComposerDraftContentState(
  current: Record<string, ComposerDraft>,
  draftKey: string,
  content: ComposerDraftContent,
): Record<string, ComposerDraft> {
  const existing = normalizeDraft(current[draftKey]);
  if (content.sourceShareId && existing.importedShareIds?.includes(content.sourceShareId)) {
    return current;
  }
  const attachmentIds = new Set(existing.attachments.map((attachment) => attachment.id));
  const incomingAttachments = content.attachments.filter((attachment) => {
    if (attachmentIds.has(attachment.id)) {
      return false;
    }
    attachmentIds.add(attachment.id);
    return true;
  });
  const attachments = [...existing.attachments, ...incomingAttachments].slice(
    0,
    PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  );
  const text = mergeComposerDraftText(existing.text, content.text);
  const importedShareIds = content.sourceShareId
    ? [...(existing.importedShareIds ?? []), content.sourceShareId]
    : existing.importedShareIds;
  if (
    text === existing.text &&
    attachments.length === existing.attachments.length &&
    importedShareIds === existing.importedShareIds
  ) {
    return current;
  }
  return {
    ...current,
    [draftKey]: {
      ...existing,
      text,
      attachments,
      ...(importedShareIds ? { importedShareIds } : {}),
    },
  };
}

/**
 * Atomically moves an incoming share into a project-scoped composer draft.
 * The durable write happens before the share inbox item can be acknowledged.
 */
export async function mergeComposerDraftContent(
  draftKey: string,
  content: ComposerDraftContent,
): Promise<{ readonly skippedAttachmentCount: number }> {
  ensureComposerDraftsLoaded();
  if (loadPromise !== null) {
    await loadPromise;
  }
  const current = appAtomRegistry.get(composerDraftsAtom);
  const next = mergeComposerDraftContentState(current, draftKey, content);
  const currentAttachmentIds = new Set(
    normalizeDraft(current[draftKey]).attachments.map((attachment) => attachment.id),
  );
  const nextAttachmentIds = new Set(
    normalizeDraft(next[draftKey]).attachments.map((attachment) => attachment.id),
  );
  const skippedAttachmentCount = content.attachments.filter(
    (attachment) =>
      !currentAttachmentIds.has(attachment.id) && !nextAttachmentIds.has(attachment.id),
  ).length;
  // Publish the content and its import receipt together before the filesystem
  // await. Typing during persistence then builds on the receipt-bearing state,
  // and its debounced write is serialized after this transaction.
  if (next !== current) {
    appAtomRegistry.set(composerDraftsAtom, next);
  }
  removePendingDraftKey(draftKey);
  try {
    await persistDraftKeys(next, new Set([draftKey]), { verify: true });
    return { skippedAttachmentCount };
  } catch (error) {
    requeueDraftPersistence(draftKey);
    throw error;
  }
}

/** Restores the exact content/settings captured before an interrupted import. */
export async function restoreComposerDraftSnapshot(
  draftKey: string,
  snapshot: ComposerDraft,
): Promise<void> {
  ensureComposerDraftsLoaded();
  if (loadPromise !== null) {
    await loadPromise;
  }
  const next = restoreComposerDraftSnapshotState(
    appAtomRegistry.get(composerDraftsAtom),
    draftKey,
    snapshot,
  );
  appAtomRegistry.set(composerDraftsAtom, next);
  removePendingDraftKey(draftKey);
  try {
    await persistDraftKeys(next, new Set([draftKey]), {
      verify: true,
      sweepAttachments: true,
    });
  } catch (error) {
    requeueDraftPersistence(draftKey, { sweepAttachments: true });
    throw error;
  }
}

export function clearComposerDraftContent(
  draftKey: string,
  options?: { readonly clearWorkspaceSelection?: boolean },
): void {
  updateComposerDrafts(
    draftKey,
    (current) => clearComposerDraftContentState(current, draftKey, options),
    { immediate: true, sweepAttachments: true, discardPartial: true },
  );
}

export function clearComposerDraftContentIfUnchanged(
  draftKey: string,
  expected: Pick<ComposerDraft, "text" | "attachments">,
): void {
  updateComposerDrafts(
    draftKey,
    (current) => clearComposerDraftContentIfUnchangedState(current, draftKey, expected),
    {
      immediate: true,
      sweepAttachments: true,
      discardPartial: true,
      discardPartialOnlyWhenChanged: true,
    },
  );
}

export function clearComposerDraft(draftKey: string): void {
  updateComposerDrafts(
    draftKey,
    (current) => {
      if (!current[draftKey]) {
        return current;
      }
      const next = { ...current };
      delete next[draftKey];
      return next;
    },
    { immediate: true, sweepAttachments: true, discardPartial: true },
  );
}

export function removeComposerDraftsForEnvironment(
  drafts: Record<string, ComposerDraft>,
  environmentId: EnvironmentId,
): Record<string, ComposerDraft> {
  const environmentPrefix = `${environmentId}:`;
  const newTaskPrefix = `new-task:${environmentId}:`;
  return Object.fromEntries(
    Object.entries(drafts).filter(
      ([draftKey]) =>
        !draftKey.startsWith(environmentPrefix) && !draftKey.startsWith(newTaskPrefix),
    ),
  );
}

export async function clearComposerDraftsEnvironment(environmentId: EnvironmentId): Promise<void> {
  ensureComposerDraftsLoaded();
  if (loadPromise !== null) {
    await loadPromise;
  }

  const current = appAtomRegistry.get(composerDraftsAtom);
  const next = removeComposerDraftsForEnvironment(current, environmentId);
  const removedDraftKeys = Object.keys(current).filter((draftKey) => !(draftKey in next));
  for (const draftKey of removedDraftKeys) {
    removePendingDraftKey(draftKey);
  }
  appAtomRegistry.set(composerDraftsAtom, next);
  try {
    await persistDraftKeys(next, new Set(removedDraftKeys), {
      verify: true,
      sweepAttachments: true,
      discardPartial: true,
    });
  } catch (error) {
    const failed = failedDraftKeys(error, new Set(removedDraftKeys));
    requeueFailedDrafts(failed, true, failed);
    throw error;
  }
}

export function useComposerDraft(draftKey: string | null): ComposerDraft {
  const drafts = useAtomValue(composerDraftsAtom);
  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);
  return draftKey ? normalizeDraft(drafts[draftKey]) : EMPTY_DRAFT;
}
