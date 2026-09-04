import { useAtomValue } from "@effect/atom-react";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type EnvironmentId,
  type MessageInputOrigin,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import { useEffect } from "react";
import { Atom } from "effect/unstable/reactivity";

import { composerDraftEnvironmentId } from "../lib/composerAttachmentUploadQueue";
import {
  composerAttachmentFileReferenceKey,
  isComposerAttachmentFileRetained,
  retainComposerAttachmentFile,
} from "../lib/composerAttachmentFiles";
import type { DraftComposerAttachment, DraftComposerFileAttachment } from "../lib/composerImages";
import { isServerThreadDraftKey } from "../lib/scopedEntities";
import { SerializedAsyncQueue } from "../lib/serialized-async-queue";
import { appAtomRegistry } from "./atom-registry";
import {
  ComposerDraftBatchPersistenceError,
  ComposerDraftPersistenceError,
  decodePersistedComposerDrafts,
  hydratePersistedComposerDraftKey,
  loadPersistedComposerCloudDraftState,
  loadPersistedComposerDraftState,
  loadStickyComposerModelSelection,
  persistComposerDraftKeys,
  savePersistedComposerCloudDraftState,
  saveStickyComposerModelSelection,
  type PersistedComposerCloudDraftState,
} from "./composer-draft-persistence";
import { flushThreadOutbox, threadOutboxManager } from "./thread-outbox";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import { removeStagedThreadSettingsForEnvironment } from "./use-thread-staged-settings";

export { ComposerDraftPersistenceError, decodePersistedComposerDrafts };

const PERSIST_DEBOUNCE_MS = 1_000;
const PERSIST_MAX_DELAY_MS = 5_000;
const PERSIST_RETRY_MAX_ATTEMPTS = 5;
const PERSIST_RETRY_MAX_DELAY_MS = 30_000;

export interface ComposerDraft {
  readonly text: string;
  readonly inputOrigin?: MessageInputOrigin;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly importedShareIds?: ReadonlyArray<string>;
  readonly modelSelection?: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly workspaceSelection?: ComposerDraftWorkspaceSelection;
}

export interface ComposerDraftContent {
  readonly text: string;
  readonly inputOrigin?: MessageInputOrigin;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
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

export const stickyComposerModelSelectionAtom = Atom.make<ModelSelection | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:sticky-composer-model-selection"),
);

export const composerCloudDraftsAtom = Atom.make<PersistedComposerCloudDraftState>({
  accountId: null,
  signedOut: {},
}).pipe(Atom.keepAlive, Atom.withLabel("mobile:composer-cloud-drafts"));

let loadPromise: Promise<void> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistMaxDelayTimer: ReturnType<typeof setTimeout> | null = null;
let hydrationComplete = false;
let cloudPersistencePending = false;
const persistRetryAttempts = new Map<string, number>();
const draftKeysMutatedBeforeHydration = new Set<string>();
const partialDraftKeys = new Set<string>();
const partialVisibleAttachmentIds = new Map<string, ReadonlySet<string>>();
const persistenceQueue = new SerializedAsyncQueue();

/** Resets module-level state between test runs. */
export function resetComposerDraftsLoadState(): void {
  loadPromise = null;
  hydrationComplete = false;
}

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

function stripThreadDraftSettings(draft: ComposerDraft): ComposerDraft {
  const {
    modelSelection: _modelSelection,
    runtimeMode: _runtimeMode,
    interactionMode: _interactionMode,
    ...stripped
  } = draft;
  return stripped;
}

function sanitizeHydratedComposerDraft(
  draftKey: string,
  draft: ComposerDraft,
): ComposerDraft | null {
  let sanitized = isServerThreadDraftKey(draftKey) ? stripThreadDraftSettings(draft) : draft;
  // Stale new-task drafts left on disk by builds before the model-precedence
  // fix carry a bare modelSelection with no other selector settings. Strip it
  // so the next compose pass re-resolves project -> sticky -> provider
  // defaults. Drafts with runtime/interaction/workspace settings or actual
  // text / attachments were deliberately configured and are left alone.
  if (
    draftKey.startsWith("new-task:") &&
    sanitized.modelSelection &&
    sanitized.text.length === 0 &&
    sanitized.attachments.length === 0 &&
    sanitized.runtimeMode === undefined &&
    sanitized.interactionMode === undefined &&
    sanitized.workspaceSelection === undefined
  ) {
    const { modelSelection: _staleModelSelection, ...rest } = sanitized;
    sanitized = rest;
  }
  // importedShareIds are share-import receipts: a contentless draft carrying
  // one is not empty, or the same native share would re-import after restart.
  if (isEmptyDraft(sanitized) && (sanitized.importedShareIds?.length ?? 0) === 0) {
    return null;
  }
  return sanitized;
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
  recovered: ReadonlyArray<DraftComposerAttachment>,
  latest: ReadonlyArray<DraftComposerAttachment>,
  previouslyVisibleIds: ReadonlySet<string>,
): ReadonlyArray<DraftComposerAttachment> {
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
  if (!hydrationComplete) {
    try {
      await waitForComposerDraftsLoaded();
    } catch {
      if (pendingDraftKeys.size > 0) {
        requeueFailedDrafts(new Set(pendingDraftKeys), pendingAttachmentSweep);
      }
      return;
    }
  }

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

async function persistComposerCloudDraftState(
  state = appAtomRegistry.get(composerCloudDraftsAtom),
): Promise<void> {
  cloudPersistencePending = true;
  await persistenceQueue.run(() => savePersistedComposerCloudDraftState(state, { verify: true }));
  if (appAtomRegistry.get(composerCloudDraftsAtom) === state) {
    cloudPersistencePending = false;
  }
}

export async function flushComposerDrafts(): Promise<void> {
  clearPersistenceTimers();
  await savePendingComposerDrafts();
  if (!hydrationComplete) {
    return;
  }
  if (cloudPersistencePending) {
    await persistComposerCloudDraftState();
  }
  clearPersistenceTimers();
  if (pendingDraftKeys.size > 0 || pendingAttachmentSweep) {
    await savePendingComposerDrafts();
  }
  if (cloudPersistencePending) {
    await persistComposerCloudDraftState();
  }
}

/**
 * Whether a flush left draft state unwritten. Persistence is best-effort and
 * retries on its own, so ordinary callers ignore this — but the update flow
 * must not tear the runtime down while it is true, because a restart is the one
 * moment where a failed write loses the draft for good.
 */
export function hasUnpersistedComposerDrafts(): boolean {
  return cloudPersistencePending || pendingDraftKeys.size > 0 || pendingAttachmentSweep;
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

function signedOutAttachmentOwners(): ReadonlyArray<ComposerDraft | QueuedThreadMessage> {
  return Object.values(appAtomRegistry.get(composerCloudDraftsAtom).signedOut).flatMap((saved) => [
    ...Object.values(saved.drafts),
    ...saved.queuedMessages,
  ]);
}

function isComposerAttachmentFileReferenced(fileUri: string): boolean {
  if (isComposerAttachmentFileRetained(fileUri)) {
    return true;
  }
  const referenceKey = composerAttachmentFileReferenceKey(fileUri);
  const drafts = Object.values(appAtomRegistry.get(composerDraftsAtom));
  const queuedMessages = Object.values(
    appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
  ).flat();
  return [...drafts, ...queuedMessages, ...signedOutAttachmentOwners()].some((owner) =>
    owner.attachments.some(
      (attachment) =>
        attachment.type === "file" &&
        composerAttachmentFileReferenceKey(attachment.fileUri) === referenceKey,
    ),
  );
}

function isComposerAttachmentUploadReferenced(
  environmentId: EnvironmentId,
  attachmentId: string,
): boolean {
  const drafts = Object.values(appAtomRegistry.get(composerDraftsAtom));
  const queuedMessages = Object.values(
    appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
  ).flat();
  return [...drafts, ...queuedMessages, ...signedOutAttachmentOwners()].some((owner) =>
    owner.attachments.some(
      (attachment) =>
        attachment.uploadEnvironmentId === environmentId &&
        attachment.uploadedAttachmentId === attachmentId,
    ),
  );
}

export async function releaseUnusedComposerAttachmentFiles(
  attachments: ReadonlyArray<DraftComposerAttachment>,
): Promise<void> {
  const candidates = new Set(
    attachments
      .filter((attachment) => attachment.type === "file")
      .map((attachment) => attachment.fileUri),
  );
  const uploadCandidates = new Map<EnvironmentId, Set<string>>();
  for (const attachment of attachments) {
    if (
      attachment.uploadEnvironmentId === undefined ||
      attachment.uploadedAttachmentId === undefined
    ) {
      continue;
    }
    const ids = uploadCandidates.get(attachment.uploadEnvironmentId) ?? new Set<string>();
    ids.add(attachment.uploadedAttachmentId);
    uploadCandidates.set(attachment.uploadEnvironmentId, ids);
  }
  if (candidates.size === 0 && uploadCandidates.size === 0) {
    return;
  }

  // Persisted drafts must hydrate before the reference scan. On a cold start
  // the atom is still empty, and every file a persisted draft owns would look
  // unused. Hydrate before flushing so a pending pre-hydration write cannot
  // land an incomplete snapshot either.
  await waitForComposerDraftsLoaded();
  await flushComposerDrafts();
  if (hasUnpersistedComposerDrafts()) {
    // The persisted draft snapshot may still own these files. Retry on a later
    // sweep rather than deleting bytes from underneath an unwritten record.
    return;
  }
  if (!(await threadOutboxManager.load())) {
    // An unreadable outbox store must not look like an empty queue: deleting
    // now would take bytes a persisted queued message still needs. Skip the
    // sweep; the next one retries hydration.
    return;
  }
  await flushThreadOutbox();

  const allFilesReferenced = [...candidates].every(isComposerAttachmentFileReferenced);
  const allUploadsReferenced = [...uploadCandidates].every(([environmentId, attachmentIds]) =>
    [...attachmentIds].every((attachmentId) =>
      isComposerAttachmentUploadReferenced(environmentId, attachmentId),
    ),
  );
  if (allFilesReferenced && allUploadsReferenced) {
    return;
  }

  let incomingShareFileUris: ReadonlySet<string>;
  try {
    const { loadIncomingShareDrafts } = await import("../features/sharing/incoming-share-storage");
    const incomingShares = await loadIncomingShareDrafts({ strict: true });
    incomingShareFileUris = new Set(
      incomingShares.flatMap((share) =>
        share.attachments.flatMap((attachment) =>
          attachment.type === "file"
            ? [composerAttachmentFileReferenceKey(attachment.fileUri)]
            : [],
        ),
      ),
    );
  } catch (error) {
    console.warn("[composer-attachments] could not verify incoming share ownership", error);
    return;
  }

  const { removePersistedComposerAttachmentFile } = await import("../lib/composerImages");
  for (const fileUri of candidates) {
    // Re-check ownership immediately before each deletion: a restore or edit
    // can re-own a file after an earlier scan decided it was unused.
    if (
      isComposerAttachmentFileReferenced(fileUri) ||
      incomingShareFileUris.has(composerAttachmentFileReferenceKey(fileUri))
    ) {
      continue;
    }
    await removePersistedComposerAttachmentFile(fileUri);
  }

  if (uploadCandidates.size > 0) {
    const { releasePendingAttachmentUploads } = await import("../lib/attachmentUpload");
    for (const [environmentId, attachmentIds] of uploadCandidates) {
      for (const attachmentId of attachmentIds) {
        // A different draft or queued message can reuse the same pending
        // upload with another local URI. Re-check the server-side ownership
        // key immediately before deletion.
        if (isComposerAttachmentUploadReferenced(environmentId, attachmentId)) {
          continue;
        }
        try {
          await releasePendingAttachmentUploads(environmentId, [attachmentId]);
        } catch (error) {
          // The server expires stale pending uploads. Local discard must still
          // complete when the environment is disconnected or deletion fails.
          console.warn("[composer-attachments] could not remove pending upload", {
            environmentId,
            attachmentId,
            error,
          });
        }
      }
    }
  }
}

export function scheduleUnusedComposerAttachmentCleanup(
  attachments: ReadonlyArray<DraftComposerAttachment>,
): void {
  if (
    !attachments.some(
      (attachment) => attachment.type === "file" || attachment.uploadedAttachmentId !== undefined,
    )
  ) {
    return;
  }
  void releaseUnusedComposerAttachmentFiles(attachments).catch((error) => {
    console.warn("[composer-attachments] could not remove unused files", error);
  });
}

/** Keeps a native preview or share copy readable until it finishes. */
export function retainComposerAttachmentFileForPreview(
  attachment: DraftComposerFileAttachment,
): () => void {
  return retainComposerAttachmentFile(attachment.fileUri, () => {
    scheduleUnusedComposerAttachmentCleanup([attachment]);
  });
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
  cloudPersistencePending = false;
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
    Object.entries(persistedDrafts).flatMap(([draftKey, draft]) => {
      if (mutatedDraftKeys.has(draftKey)) {
        return [];
      }
      const sanitized = sanitizeHydratedComposerDraft(draftKey, draft);
      return sanitized ? [[draftKey, sanitized]] : [];
    }),
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
  const loading = persistenceQueue
    .run(async () => ({
      draftState: await loadPersistedComposerDraftState(),
      stickyModelSelection: await loadStickyComposerModelSelection(),
      cloudDrafts: await loadPersistedComposerCloudDraftState(),
    }))
    .then(({ draftState: persisted, stickyModelSelection, cloudDrafts }) => {
      appAtomRegistry.set(composerCloudDraftsAtom, cloudDrafts);
      cloudPersistencePending = false;
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
      if (
        stickyModelSelection !== null &&
        appAtomRegistry.get(stickyComposerModelSelectionAtom) === null
      ) {
        appAtomRegistry.set(stickyComposerModelSelectionAtom, stickyModelSelection);
      }
      hydrationComplete = true;
      draftKeysMutatedBeforeHydration.clear();
    });
  loadPromise = loading;
  // Keep fire-and-forget hook loads observable without swallowing the
  // rejection from persistence and cleanup callers. A later call retries.
  void loading.catch((cause) => {
    if (loadPromise === loading) loadPromise = null;
    console.warn(
      "[composer-drafts] failed to hydrate drafts",
      cause instanceof ComposerDraftPersistenceError
        ? cause
        : new ComposerDraftPersistenceError({
            operation: "hydrate",
            directory: "composer-drafts",
            fileName: "*",
            cause,
          }),
    );
  });
}

/** Wait until persisted drafts have been merged into the in-memory composer state. */
export async function waitForComposerDraftsLoaded(): Promise<void> {
  ensureComposerDraftsLoaded();
  if (loadPromise !== null) {
    await loadPromise;
  }
}

export async function getComposerCloudAccountId(): Promise<string | null> {
  await waitForComposerDraftsLoaded();
  return appAtomRegistry.get(composerCloudDraftsAtom).accountId;
}

/** Save an account's local work before its relay environments are removed. */
export async function archiveCloudComposerDrafts(
  accountId: string | null,
  environmentIds: ReadonlySet<EnvironmentId>,
): Promise<void> {
  await waitForComposerDraftsLoaded();
  if (!(await threadOutboxManager.load())) {
    throw new Error("Could not preserve queued messages.");
  }
  await flushThreadOutbox();

  const cloud = appAtomRegistry.get(composerCloudDraftsAtom);
  const owner = accountId ?? cloud.accountId;
  if (owner === null) {
    return;
  }
  const queued = Object.values(
    appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
  ).flat();
  const current = appAtomRegistry.get(composerDraftsAtom);
  const remaining = { ...current };
  const savedDrafts = { ...cloud.signedOut[owner]?.drafts };
  const removedDraftKeys = new Set<string>();
  for (const [draftKey, draft] of Object.entries(current)) {
    const environmentId = composerDraftEnvironmentId(draftKey, queued);
    if (environmentId !== null && environmentIds.has(environmentId)) {
      savedDrafts[draftKey] = draft;
      delete remaining[draftKey];
      removedDraftKeys.add(draftKey);
    }
  }
  const savedMessages = new Map(
    (cloud.signedOut[owner]?.queuedMessages ?? []).map((message) => [message.messageId, message]),
  );
  for (const message of queued) {
    if (environmentIds.has(message.environmentId)) {
      savedMessages.set(message.messageId, message);
    }
  }
  const nextCloud: PersistedComposerCloudDraftState = {
    accountId: owner,
    signedOut: {
      ...cloud.signedOut,
      [owner]: { drafts: savedDrafts, queuedMessages: [...savedMessages.values()] },
    },
  };

  // Land the backup before removing live records. A failed archive therefore
  // leaves the original durable drafts intact for a later retry.
  appAtomRegistry.set(composerCloudDraftsAtom, nextCloud);
  await persistComposerCloudDraftState(nextCloud);
  appAtomRegistry.set(composerDraftsAtom, remaining);
  for (const draftKey of removedDraftKeys) {
    removePendingDraftKey(draftKey);
  }
  try {
    await persistDraftKeys(remaining, removedDraftKeys, { verify: true });
  } catch (error) {
    requeueFailedDrafts(failedDraftKeys(error, removedDraftKeys), false);
    throw error;
  }
}

function sameDraftAttachmentIds(
  left: ReadonlyArray<DraftComposerAttachment>,
  right: ReadonlyArray<DraftComposerAttachment>,
): boolean {
  return (
    left.length === right.length &&
    left.every((attachment, index) => attachment.id === right[index]?.id)
  );
}

/** An in-flight delivery can finish after sign-out took its snapshot. */
export async function removeDeliveredCloudQueuedMessage(
  message: QueuedThreadMessage,
): Promise<void> {
  await waitForComposerDraftsLoaded();
  const cloud = appAtomRegistry.get(composerCloudDraftsAtom);
  const signedOut = { ...cloud.signedOut };
  let changed = false;
  for (const [accountId, saved] of Object.entries(signedOut)) {
    const archived = saved.queuedMessages.find(
      (candidate) =>
        candidate.environmentId === message.environmentId &&
        candidate.messageId === message.messageId,
    );
    if (
      !archived ||
      archived.commandId !== message.commandId ||
      archived.threadId !== message.threadId ||
      archived.text !== message.text ||
      !sameDraftAttachmentIds(archived.attachments, message.attachments)
    ) {
      continue;
    }
    if (
      JSON.stringify([
        archived.inputOrigin,
        archived.modelSelection,
        archived.runtimeMode,
        archived.interactionMode,
        archived.deliveryIntent,
        archived.localCheckoutBranch,
        archived.creation,
        archived.threadSettings,
        archived.graceStartedAt,
      ]) !==
      JSON.stringify([
        message.inputOrigin,
        message.modelSelection,
        message.runtimeMode,
        message.interactionMode,
        message.deliveryIntent,
        message.localCheckoutBranch,
        message.creation,
        message.threadSettings,
        message.graceStartedAt,
      ])
    ) {
      continue;
    }
    const editorKey = `pending-task:${message.messageId}`;
    const editor = saved.drafts[editorKey];
    if (
      editor &&
      (editor.text !== message.text ||
        editor.inputOrigin !== message.inputOrigin ||
        !sameDraftAttachmentIds(editor.attachments, message.attachments) ||
        (editor.modelSelection !== undefined &&
          JSON.stringify(editor.modelSelection) !== JSON.stringify(message.modelSelection)) ||
        (editor.runtimeMode !== undefined && editor.runtimeMode !== message.runtimeMode) ||
        (editor.interactionMode !== undefined &&
          editor.interactionMode !== message.interactionMode) ||
        (editor.workspaceSelection !== undefined &&
          (editor.workspaceSelection.mode !== message.creation?.workspaceMode ||
            editor.workspaceSelection.branch !== message.creation?.branch ||
            editor.workspaceSelection.worktreePath !== message.creation?.worktreePath ||
            (editor.workspaceSelection.startFromOrigin ?? false) !==
              (message.creation?.startFromOrigin ?? false))))
    ) {
      continue;
    }
    const drafts = { ...saved.drafts };
    delete drafts[editorKey];
    signedOut[accountId] = {
      drafts,
      queuedMessages: saved.queuedMessages.filter((candidate) => candidate !== archived),
    };
    changed = true;
  }
  if (!changed) {
    return;
  }
  const nextCloud = { ...cloud, signedOut };
  appAtomRegistry.set(composerCloudDraftsAtom, nextCloud);
  await persistComposerCloudDraftState(nextCloud);
}

/** Restores only this account, before its connections can deliver queued turns. */
export async function restoreCloudComposerDrafts(accountId: string): Promise<void> {
  await waitForComposerDraftsLoaded();
  const cloud = appAtomRegistry.get(composerCloudDraftsAtom);
  const saved = cloud.signedOut[accountId];
  if (saved) {
    if (!(await threadOutboxManager.load())) {
      throw new Error("Could not restore queued messages.");
    }
    for (const message of saved.queuedMessages) {
      const alreadyQueued = Object.values(
        appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
      )
        .flat()
        .some((current) => current.messageId === message.messageId);
      if (!alreadyQueued) {
        await threadOutboxManager.enqueue(message);
      }
    }

    const current = appAtomRegistry.get(composerDraftsAtom);
    const restored = { ...current };
    for (const [draftKey, draft] of Object.entries(saved.drafts)) {
      const existing = current[draftKey];
      const attachmentIds = new Set(existing?.attachments.map((attachment) => attachment.id));
      restored[draftKey] = existing
        ? {
            ...draft,
            ...existing,
            text: mergeComposerDraftText(existing.text, draft.text),
            attachments: [
              ...existing.attachments,
              ...draft.attachments.filter((attachment) => !attachmentIds.has(attachment.id)),
            ],
            importedShareIds: [
              ...new Set([...(existing.importedShareIds ?? []), ...(draft.importedShareIds ?? [])]),
            ],
          }
        : draft;
    }
    appAtomRegistry.set(composerDraftsAtom, restored);
    const restoredKeys = new Set(Object.keys(saved.drafts));
    try {
      await persistDraftKeys(restored, restoredKeys, { verify: true });
    } catch (error) {
      requeueFailedDrafts(failedDraftKeys(error, restoredKeys), false);
      throw error;
    }
  }

  const signedOut = { ...cloud.signedOut };
  delete signedOut[accountId];
  const nextCloud = { accountId, signedOut };
  appAtomRegistry.set(composerCloudDraftsAtom, nextCloud);
  await persistComposerCloudDraftState(nextCloud);
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

export function setStickyComposerModelSelection(modelSelection: ModelSelection): void {
  appAtomRegistry.set(stickyComposerModelSelectionAtom, modelSelection);
  // Sticky selection lives in its own small file: best-effort, serialized
  // behind the draft queue so it cannot interleave with record writes.
  void persistenceQueue
    .run(() => saveStickyComposerModelSelection(modelSelection))
    .catch((error) => {
      console.warn("[composer-drafts] failed to persist sticky model selection", error);
    });
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
    readonly inputOrigin?: MessageInputOrigin;
    readonly attachments: ReadonlyArray<DraftComposerAttachment>;
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
    ...(before.inputOrigin === undefined && input.inputOrigin !== undefined
      ? { inputOrigin: input.inputOrigin }
      : {}),
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

function sameComposerAttachmentValue(
  left: DraftComposerAttachment,
  right: DraftComposerAttachment,
): boolean {
  if (
    left.id !== right.id ||
    left.type !== right.type ||
    left.name !== right.name ||
    left.mimeType !== right.mimeType ||
    left.sizeBytes !== right.sizeBytes
  ) {
    return false;
  }
  return left.type === "image" && right.type === "image"
    ? left.dataUrl === right.dataUrl &&
        left.uploadedAttachmentId === right.uploadedAttachmentId &&
        left.uploadEnvironmentId === right.uploadEnvironmentId
    : left.type === "file" &&
        right.type === "file" &&
        left.fileUri === right.fileUri &&
        left.uploadedAttachmentId === right.uploadedAttachmentId &&
        left.uploadEnvironmentId === right.uploadEnvironmentId;
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
    const index = remaining.findIndex((candidate) =>
      sameComposerAttachmentValue(candidate, attachment),
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

/**
 * Appends attachments to a draft, capped at the send limit against the draft's
 * live state (callers may have counted before an await; the picker can race
 * concurrent adds). Overflowed file attachments are released. Returns how many
 * were rejected. Restore paths pass allowOverflow so a failed send never drops
 * the message's own attachments.
 */
export function appendComposerDraftAttachments(
  draftKey: string,
  attachments: ReadonlyArray<DraftComposerAttachment>,
  options?: { readonly allowOverflow?: boolean },
): number {
  if (attachments.length === 0) {
    return 0;
  }
  let rejected: ReadonlyArray<DraftComposerAttachment> = [];
  updateComposerDrafts(draftKey, (current) => {
    const existing = normalizeDraft(current[draftKey]);
    const remaining = options?.allowOverflow
      ? attachments.length
      : Math.max(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS - existing.attachments.length);
    const accepted = attachments.slice(0, remaining);
    rejected = attachments.slice(remaining);
    if (accepted.length === 0) {
      return current;
    }
    return {
      ...current,
      [draftKey]: {
        ...existing,
        attachments: [...existing.attachments, ...accepted],
      },
    };
  });
  scheduleUnusedComposerAttachmentCleanup(rejected);
  return rejected.length;
}

export function replaceComposerDraftAttachments(
  draftKey: string,
  attachments: ReadonlyArray<DraftComposerAttachment>,
): void {
  const previousAttachments = getComposerDraftSnapshot(draftKey).attachments;
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
  const retainedIds = new Set(attachments.map((attachment) => attachment.id));
  scheduleUnusedComposerAttachmentCleanup(
    previousAttachments.filter((attachment) => !retainedIds.has(attachment.id)),
  );
}

export function removeComposerDraftAttachment(draftKey: string, attachmentId: string): void {
  const previousAttachments = getComposerDraftSnapshot(draftKey).attachments;
  updateComposerDrafts(
    draftKey,
    (current) => {
      const existing = normalizeDraft(current[draftKey]);
      const draft = {
        ...existing,
        attachments: existing.attachments.filter((attachment) => attachment.id !== attachmentId),
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
  scheduleUnusedComposerAttachmentCleanup(
    previousAttachments.filter((attachment) => attachment.id === attachmentId),
  );
}

/** Stamps a finished upload without overwriting text, removals, or newer attachment fields. */
export function setComposerDraftAttachmentUpload(
  draftKey: string,
  attachment: DraftComposerAttachment,
): boolean {
  let previous: DraftComposerAttachment | undefined;
  updateComposerDrafts(draftKey, (current) => {
    const draft = current[draftKey];
    previous = draft?.attachments.find((candidate) => candidate.id === attachment.id);
    if (!draft || !previous) {
      return current;
    }
    if (
      previous.uploadedAttachmentId === attachment.uploadedAttachmentId &&
      previous.uploadEnvironmentId === attachment.uploadEnvironmentId
    ) {
      return current;
    }
    return {
      ...current,
      [draftKey]: {
        ...draft,
        attachments: draft.attachments.map((candidate) =>
          candidate.id === attachment.id
            ? {
                ...candidate,
                uploadedAttachmentId: attachment.uploadedAttachmentId,
                uploadEnvironmentId: attachment.uploadEnvironmentId,
              }
            : candidate,
        ),
      },
    };
  });
  if (previous) {
    scheduleUnusedComposerAttachmentCleanup([previous]);
  }
  return previous !== undefined;
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
  options?: {
    readonly clearModelSelection?: boolean;
    readonly clearWorkspaceSelection?: boolean;
  },
): Record<string, ComposerDraft> {
  const existing = current[draftKey];
  if (!existing) {
    return current;
  }
  const {
    importedShareIds: _importedShareIds,
    inputOrigin: _inputOrigin,
    modelSelection,
    workspaceSelection,
    ...retained
  } = existing;
  const retainedSettings = isServerThreadDraftKey(draftKey)
    ? stripThreadDraftSettings(retained)
    : retained;
  const draft = {
    ...retainedSettings,
    // Server-thread drafts never retain a model selection across a clear
    // (stripThreadDraftSettings semantics); new-task drafts keep it unless
    // the caller asks for a full reset.
    ...(options?.clearModelSelection ||
    modelSelection === undefined ||
    isServerThreadDraftKey(draftKey)
      ? {}
      : { modelSelection }),
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
  expected: Pick<ComposerDraft, "text" | "inputOrigin" | "attachments">,
): Record<string, ComposerDraft> {
  const existing = current[draftKey];
  if (
    !existing ||
    existing.text !== expected.text ||
    existing.inputOrigin !== expected.inputOrigin ||
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
    source.inputOrigin !== undefined ||
    source.attachments.length > 0 ||
    (source.importedShareIds?.length ?? 0) > 0;
  const targetHasContent =
    target.text.length > 0 ||
    target.inputOrigin !== undefined ||
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
      ...(source.inputOrigin !== undefined ? { inputOrigin: source.inputOrigin } : {}),
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
  const inputOrigin = existing.inputOrigin ?? content.inputOrigin;
  const importedShareIds = content.sourceShareId
    ? [...(existing.importedShareIds ?? []), content.sourceShareId]
    : existing.importedShareIds;
  if (
    text === existing.text &&
    inputOrigin === existing.inputOrigin &&
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
      ...(inputOrigin !== undefined ? { inputOrigin } : {}),
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

export function sameComposerDraftState(a: ComposerDraft, b: ComposerDraft): boolean {
  return (
    a.text === b.text &&
    a.inputOrigin === b.inputOrigin &&
    a.attachments === b.attachments &&
    a.importedShareIds === b.importedShareIds &&
    a.modelSelection === b.modelSelection &&
    a.runtimeMode === b.runtimeMode &&
    a.interactionMode === b.interactionMode &&
    a.workspaceSelection === b.workspaceSelection
  );
}

/**
 * Undoes an abandoned mergeComposerDraftContent. When the draft is untouched
 * since `merged` (the state captured right after the merge), the pre-merge
 * snapshot comes back exactly. When the user edited the draft during the
 * merge's awaits, only what the merge inserted (the appended text and the new
 * attachments) is taken back out, so the user's edits survive the rollback.
 */
export function undoComposerDraftMergeState(
  current: Record<string, ComposerDraft>,
  draftKey: string,
  snapshot: ComposerDraft,
  merged: ComposerDraft,
): Record<string, ComposerDraft> {
  const existing = normalizeDraft(current[draftKey]);
  if (sameComposerDraftState(existing, merged)) {
    return restoreComposerDraftSnapshotState(current, draftKey, snapshot);
  }
  const insertedText = merged.text.startsWith(snapshot.text)
    ? merged.text.slice(snapshot.text.length)
    : "";
  const snapshotAttachmentIds = new Set(snapshot.attachments.map((attachment) => attachment.id));
  const insertedAttachmentIds = new Set(
    merged.attachments
      .filter((attachment) => !snapshotAttachmentIds.has(attachment.id))
      .map((attachment) => attachment.id),
  );
  // A setting still holding the merge's value is the merge's doing: restore
  // the snapshot's. One the user changed since the merge stays theirs.
  const undoSetting = <
    K extends "modelSelection" | "runtimeMode" | "interactionMode" | "workspaceSelection",
  >(
    key: K,
  ): ComposerDraft[K] => (existing[key] === merged[key] ? snapshot[key] : existing[key]);
  const text =
    insertedText.length > 0 && existing.text.startsWith(merged.text)
      ? snapshot.text + existing.text.slice(merged.text.length)
      : insertedText.length > 0 && existing.text.endsWith(insertedText)
        ? existing.text.slice(0, existing.text.length - insertedText.length)
        : existing.text;
  const inputOrigin =
    existing.inputOrigin === merged.inputOrigin ? snapshot.inputOrigin : existing.inputOrigin;
  const { inputOrigin: _existingInputOrigin, ...existingWithoutInputOrigin } = existing;
  const draft = {
    ...existingWithoutInputOrigin,
    text,
    ...(inputOrigin !== undefined ? { inputOrigin } : {}),
    attachments: existing.attachments.filter(
      (attachment) => !insertedAttachmentIds.has(attachment.id),
    ),
    modelSelection: undoSetting("modelSelection"),
    runtimeMode: undoSetting("runtimeMode"),
    interactionMode: undoSetting("interactionMode"),
    workspaceSelection: undoSetting("workspaceSelection"),
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

/** Applies undoComposerDraftMergeState and lands it durably. */
export async function undoComposerDraftMerge(
  draftKey: string,
  snapshot: ComposerDraft,
  merged: ComposerDraft,
): Promise<void> {
  ensureComposerDraftsLoaded();
  if (loadPromise !== null) {
    await loadPromise;
  }
  const current = appAtomRegistry.get(composerDraftsAtom);
  const previousAttachments = normalizeDraft(current[draftKey]).attachments;
  const next = undoComposerDraftMergeState(current, draftKey, snapshot, merged);
  appAtomRegistry.set(composerDraftsAtom, next);
  removePendingDraftKey(draftKey);
  try {
    await persistDraftKeys(next, new Set([draftKey]), {
      verify: true,
      sweepAttachments: true,
      discardPartial: true,
    });
  } catch (error) {
    requeueDraftPersistence(draftKey, { sweepAttachments: true, discardPartial: true });
    throw error;
  }
  scheduleUnusedComposerAttachmentCleanup(previousAttachments);
}

export function clearComposerDraftContent(
  draftKey: string,
  options?: {
    readonly clearModelSelection?: boolean;
    readonly clearWorkspaceSelection?: boolean;
    // Send clears the draft while the durable outbox write is still in
    // flight. Sweeping then would race the write: a failed enqueue rolls the
    // message out of the queue mid-sweep and its files get deleted right
    // before the failure handler restores them. The sender re-schedules
    // cleanup once the write settles.
    readonly deferAttachmentCleanup?: boolean;
  },
): void {
  const previousAttachments = getComposerDraftSnapshot(draftKey).attachments;
  updateComposerDrafts(
    draftKey,
    (current) => clearComposerDraftContentState(current, draftKey, options),
    { immediate: true, sweepAttachments: true, discardPartial: true },
  );
  if (!options?.deferAttachmentCleanup) {
    scheduleUnusedComposerAttachmentCleanup(previousAttachments);
  }
}

export function clearComposerDraftContentIfUnchanged(
  draftKey: string,
  expected: Pick<ComposerDraft, "text" | "inputOrigin" | "attachments">,
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
  // This path clears immediately after publishing an outbox enqueue. The queued
  // message owns the files on success, while the enqueue failure path restores
  // them; cleanup begins when one of those owners is removed.
}

export function clearComposerDraft(
  draftKey: string,
  options?: { readonly deferAttachmentCleanup?: boolean },
): void {
  const previousAttachments = getComposerDraftSnapshot(draftKey).attachments;
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
  if (!options?.deferAttachmentCleanup) {
    scheduleUnusedComposerAttachmentCleanup(previousAttachments);
  }
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

  removeStagedThreadSettingsForEnvironment(environmentId);
  const current = appAtomRegistry.get(composerDraftsAtom);
  const next = removeComposerDraftsForEnvironment(current, environmentId);
  const removedDraftKeys = Object.keys(current).filter((draftKey) => !(draftKey in next));
  const removedAttachments = removedDraftKeys.flatMap(
    (draftKey) => current[draftKey]?.attachments ?? [],
  );
  for (const draftKey of removedDraftKeys) {
    removePendingDraftKey(draftKey);
  }
  appAtomRegistry.set(composerDraftsAtom, next);
  const removedDraftKeySet = new Set(removedDraftKeys);
  try {
    await persistDraftKeys(next, removedDraftKeySet, {
      verify: true,
      sweepAttachments: true,
      discardPartial: true,
    });
  } catch (error) {
    const failed = failedDraftKeys(error, removedDraftKeySet);
    requeueFailedDrafts(failed, true, failed);
    throw error;
  }
  await releaseUnusedComposerAttachmentFiles(removedAttachments);
}

export function useComposerDraft(draftKey: string | null): ComposerDraft {
  const drafts = useAtomValue(composerDraftsAtom);
  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);
  return draftKey ? normalizeDraft(drafts[draftKey]) : EMPTY_DRAFT;
}

export function useStickyComposerModelSelection(): ModelSelection | null {
  const selection = useAtomValue(stickyComposerModelSelectionAtom);
  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);
  return selection;
}
