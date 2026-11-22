import type {
  AssetCreateUrlResult,
  AssetResource,
  EnvironmentId,
  PreviewOpenInput,
  PreviewSessionSnapshot,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { mediaFileReference } from "@t3tools/client-runtime/media-reference";
import {
  type AtomCommandResult,
  mapAtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";

import { resolveAssetUrl } from "~/assets/assetUrls";
import { isPreviewAvailableFor, previewRuntimeFor } from "~/browser/previewRuntime";
import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  rememberPreviewUrl,
  setActivePreviewTab,
  updatePreviewServerSnapshot,
} from "~/previewStateStore";
import {
  rightPanelHostRef,
  selectSelectedRightPanelSurface,
  useRightPanelStore,
} from "~/rightPanelStore";

import { resolveBrowserDefaults } from "./browserDefaults";
import { msg } from "gt-react";
import { m } from "~/i18n/messages";

export const isBrowserPreviewFile = (path: string): boolean =>
  /\.(?:html?|pdf)$/i.test(path.split(/[?#]/, 1)[0] ?? "");

export class BrowserPreviewUnavailableError extends Schema.TaggedError<BrowserPreviewUnavailableError>()(
  "BrowserPreviewUnavailableError",
  { message: Schema.String },
) {}

export class BrowserSettingsReadError extends Schema.TaggedError<BrowserSettingsReadError>()(
  "BrowserSettingsReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return m(msg("Saved browser settings could not be loaded."));
  }
}

export const isBrowserSettingsReadError = Schema.is(BrowserSettingsReadError);

export type OpenPreviewMutation<E = unknown> = (input: {
  readonly environmentId: EnvironmentId;
  readonly input: PreviewOpenInput;
}) => Promise<AtomCommandResult<PreviewSessionSnapshot, E>>;

export async function openUrlInPreview<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly url: string;
  readonly openPreview: OpenPreviewMutation<E>;
  readonly profileId?: PreviewOpenInput["profileId"];
  readonly background?: boolean;
}): Promise<AtomCommandResult<void, E | BrowserSettingsReadError>> {
  // Read before any await: a side chat pane that unmounts meanwhile drops its host mapping.
  const threadRef = rightPanelHostRef(input.threadRef);
  const defaults = await resolveBrowserDefaults().catch(
    (cause: unknown) => new BrowserSettingsReadError({ cause }),
  );
  if (isBrowserSettingsReadError(defaults)) {
    return AsyncResult.failure(Cause.fail(defaults));
  }
  const runtime = previewRuntimeFor(threadRef.environmentId);
  const previousActiveTabId = readThreadPreviewState(threadRef).activeTabId;
  // The server changes the active tab, not panel selection; selection changes come from the user.
  const selectedSurface = () =>
    selectSelectedRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef)?.id ??
    null;
  const surfaceBeforeOpen = selectedSurface();
  const result = await input.openPreview({
    environmentId: threadRef.environmentId,
    input: {
      threadId: threadRef.threadId,
      url: input.url,
      viewport: defaults.viewport,
      profileId: input.profileId ?? defaults.profileId,
      ...(runtime === undefined
        ? {}
        : { runtime, zoomFactor: defaults.zoomFactor, colorScheme: defaults.appearance }),
    },
  });
  return mapAtomCommandResult(result, (snapshot) => {
    rememberPreviewUrl(threadRef, input.url);
    if (input.background) {
      updatePreviewServerSnapshot(threadRef, snapshot);
      // Restore focus unless the user picked a tab while opening this one.
      if (
        previousActiveTabId &&
        readThreadPreviewState(threadRef).activeTabId === snapshot.tabId &&
        selectedSurface() === surfaceBeforeOpen
      ) {
        setActivePreviewTab(threadRef, previousActiveTabId);
      }
      return;
    }
    applyPreviewServerSnapshot(threadRef, snapshot);
    useRightPanelStore.getState().openBrowser(threadRef, snapshot.tabId);
  });
}

type CreateFileAssetUrl<AssetError> = (input: {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly resource: AssetResource };
}) => Promise<AtomCommandResult<AssetCreateUrlResult, AssetError>>;

async function createFileAssetUrl<AssetError>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
  readonly httpBaseUrl: string;
  readonly createAssetUrl: CreateFileAssetUrl<AssetError>;
}): Promise<AtomCommandResult<string, AssetError>> {
  const insideWorkspace =
    mediaFileReference(input.filePath, input.workspaceRoot).relativePath !== undefined;
  const assetResult = await input.createAssetUrl({
    environmentId: input.threadRef.environmentId,
    input: {
      resource: {
        _tag: insideWorkspace ? "workspace-file" : "media-file",
        threadId: input.threadRef.threadId,
        path: input.filePath,
      },
    },
  });
  if (assetResult._tag === "Failure") {
    return AsyncResult.failure(assetResult.cause);
  }
  const assetUrl = resolveAssetUrl(input.httpBaseUrl, assetResult.value.relativeUrl);
  if (assetUrl === null) {
    return AsyncResult.failure(
      Cause.die(new Error("The environment returned an invalid asset URL.")),
    );
  }
  return AsyncResult.success(assetUrl);
}

/**
 * Opens a file in the OS browser. A desktop that hosts the file opens it as itself, so the page
 * outlives T3; anywhere else the browser gets the file's signed asset URL.
 */
export async function openFileInSystemBrowser<AssetError>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly resolveFilePath: () => Promise<string>;
  readonly workspaceRoot: string | undefined;
  readonly httpBaseUrl: string;
  readonly hostIsLocal: boolean;
  readonly createAssetUrl: CreateFileAssetUrl<AssetError>;
}): Promise<AtomCommandResult<void, AssetError | BrowserPreviewUnavailableError>> {
  const bridge = window.desktopBridge;
  // Browsers block popups opened after an await, so the web tab opens within the click.
  const pendingTab = bridge ? null : window.open("", "_blank");
  try {
    const filePath = await input.resolveFilePath();
    if (bridge && input.hostIsLocal && (await bridge.openFileInBrowser(filePath))) {
      return AsyncResult.success(undefined);
    }
    const assetUrl = await createFileAssetUrl({ ...input, filePath });
    if (assetUrl._tag === "Failure") {
      pendingTab?.close();
      return AsyncResult.failure(assetUrl.cause);
    }
    if (pendingTab) {
      pendingTab.opener = null;
      pendingTab.location.replace(assetUrl.value);
      return AsyncResult.success(undefined);
    }
    // A web tab that the popup blocker refused leaves nothing to open.
    if (bridge && (await bridge.openExternal(assetUrl.value))) {
      return AsyncResult.success(undefined);
    }
    return AsyncResult.failure(
      Cause.fail(new BrowserPreviewUnavailableError({ message: m(msg("Unable to open link.")) })),
    );
  } catch (cause) {
    pendingTab?.close();
    return AsyncResult.failure(Cause.die(cause));
  }
}

export async function openFileInPreview<AssetError, PreviewError>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
  readonly httpBaseUrl: string;
  readonly createAssetUrl: CreateFileAssetUrl<AssetError>;
  readonly openPreview: OpenPreviewMutation<PreviewError>;
}): Promise<
  AtomCommandResult<
    void,
    AssetError | PreviewError | BrowserPreviewUnavailableError | BrowserSettingsReadError
  >
> {
  if (!isPreviewAvailableFor(input.threadRef.environmentId)) {
    return AsyncResult.failure(
      Cause.fail(
        new BrowserPreviewUnavailableError({
          message: m(msg("The integrated browser is unavailable in this runtime.")),
        }),
      ),
    );
  }
  const hostRef = rightPanelHostRef(input.threadRef);
  const assetUrl = await createFileAssetUrl(input);
  if (assetUrl._tag === "Failure") {
    return AsyncResult.failure(assetUrl.cause);
  }
  return openUrlInPreview({
    threadRef: hostRef,
    url: assetUrl.value,
    openPreview: input.openPreview,
  });
}
