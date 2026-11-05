import {
  DesktopPreviewAnnotationSendEnabledInputSchema,
  DesktopPreviewAnnotationThemeInputSchema,
  DesktopPreviewArtifactInputSchema,
  DesktopPreviewConfigInputSchema,
  DesktopPreviewNavigateInputSchema,
  DesktopPreviewRecordingArtifactSchema,
  DesktopPreviewRecordingSaveInputSchema,
  DesktopPreviewRegisterWebviewInputSchema,
  DesktopPreviewScreenshotArtifactSchema,
  DesktopPreviewSetAudioMutedInputSchema,
  DesktopPreviewSetShownInputSchema,
  DesktopPreviewSetColorSchemeInputSchema,
  DesktopPreviewSetZoomFactorInputSchema,
  BrowserImportResult,
  BrowserImportSource,
  DesktopPreviewClearDataInputSchema,
  DesktopPreviewImportCookiesInputSchema,
  DesktopPreviewCreateTabInputSchema,
  DesktopPreviewTabInputSchema,
  DesktopPreviewWebviewConfigSchema,
  PreviewAnnotationSubmissionResultSchema,
  PreviewCaptureFailure,
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
  PreviewForwardedShortcut,
  MAX_KEYBINDINGS_COUNT,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as NodeURL from "node:url";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as BrowserImport from "../../preview/BrowserImport/BrowserImport.ts";
import * as PreviewDashlane from "../../preview/Dashlane.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import { normalizeCaptureFailure } from "../../preview/captureErrors.ts";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import { PREVIEW_WEBVIEW_PREFERENCES } from "../../preview/WebviewPreferences.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const installPreviewEventForwarding = Effect.fn(
  "desktop.ipc.preview.installEventForwarding",
)(function* () {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const manager = yield* PreviewManager.PreviewManager;
  yield* manager.subscribeStateChanges((tabId, state) =>
    electronWindow.sendAll(IpcChannels.PREVIEW_STATE_CHANGE_CHANNEL, tabId, state),
  );
  yield* manager.subscribeRecordingInputs((event) =>
    electronWindow.sendAll(IpcChannels.PREVIEW_RECORDING_INPUT_CHANNEL, event),
  );
  yield* manager.subscribePointerEvents((event) =>
    electronWindow.sendAll(IpcChannels.PREVIEW_POINTER_EVENT_CHANNEL, event),
  );
  yield* manager.subscribeOpenLinks((event) =>
    electronWindow.sendAll(IpcChannels.PREVIEW_OPEN_LINK_CHANNEL, event),
  );
  yield* (yield* PreviewDashlane.PreviewDashlane).subscribe((event) => {
    switch (event._tag) {
      case "ActionsChanged":
        return electronWindow.sendAll(
          IpcChannels.PREVIEW_EXTENSION_ACTIONS_CHANGE_CHANNEL,
          event.webContentsId,
        );
      case "InstallationsChanged":
        return electronWindow.sendAll(IpcChannels.PREVIEW_EXTENSION_INSTALLATIONS_CHANGE_CHANNEL);
      case "PopupRequested":
        return electronWindow.sendAll(IpcChannels.PREVIEW_EXTENSION_POPUP_REQUEST_CHANNEL, {
          webContentsId: event.webContentsId,
          extensionId: event.extensionId,
        });
    }
  });
});

const setForwardedShortcuts = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_SET_FORWARDED_SHORTCUTS_CHANNEL,
  payload: Schema.Array(PreviewForwardedShortcut).check(Schema.isMaxLength(MAX_KEYBINDINGS_COUNT)),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.setForwardedShortcuts")(function* (shortcuts) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.setForwardedShortcuts(shortcuts);
  }),
});

const createTab = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CREATE_TAB_CHANNEL,
  payload: DesktopPreviewCreateTabInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.createTab")(function* ({
    tabId,
    zoomFactor,
    colorScheme,
    serverTab,
  }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.createTab(tabId, { zoomFactor, colorScheme, serverTab });
  }),
});

const closeTab = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CLOSE_TAB_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.closeTab")(function* ({ tabId }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.closeTab(tabId);
  }),
});

const registerWebview = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_REGISTER_WEBVIEW_CHANNEL,
  payload: DesktopPreviewRegisterWebviewInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.registerWebview")(function* ({ tabId, webContentsId }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.registerWebview(tabId, webContentsId);
  }),
});

const navigate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_NAVIGATE_CHANNEL,
  payload: DesktopPreviewNavigateInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.navigate")(function* ({ tabId, url }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.navigate(tabId, url);
  }),
});

const tabMethod = (
  channel: string,
  name: string,
  invoke: (
    manager: PreviewManager.PreviewManager["Service"],
    tabId: string,
  ) => Effect.Effect<void, PreviewManager.PreviewManagerError>,
) =>
  DesktopIpc.makeIpcMethod({
    channel,
    payload: DesktopPreviewTabInputSchema,
    result: Schema.Void,
    handler: Effect.fn(name)(function* ({ tabId }) {
      const manager = yield* PreviewManager.PreviewManager;
      yield* invoke(manager, tabId);
    }),
  });

const goBack = tabMethod(
  IpcChannels.PREVIEW_GO_BACK_CHANNEL,
  "desktop.ipc.preview.goBack",
  (manager, tabId) => manager.goBack(tabId),
);
const goForward = tabMethod(
  IpcChannels.PREVIEW_GO_FORWARD_CHANNEL,
  "desktop.ipc.preview.goForward",
  (manager, tabId) => manager.goForward(tabId),
);
const refresh = tabMethod(
  IpcChannels.PREVIEW_REFRESH_CHANNEL,
  "desktop.ipc.preview.refresh",
  (manager, tabId) => manager.refresh(tabId),
);
const zoomIn = tabMethod(
  IpcChannels.PREVIEW_ZOOM_IN_CHANNEL,
  "desktop.ipc.preview.zoomIn",
  (manager, tabId) => manager.zoomIn(tabId),
);
const zoomOut = tabMethod(
  IpcChannels.PREVIEW_ZOOM_OUT_CHANNEL,
  "desktop.ipc.preview.zoomOut",
  (manager, tabId) => manager.zoomOut(tabId),
);
const resetZoom = tabMethod(
  IpcChannels.PREVIEW_RESET_ZOOM_CHANNEL,
  "desktop.ipc.preview.resetZoom",
  (manager, tabId) => manager.resetZoom(tabId),
);
const hardReload = tabMethod(
  IpcChannels.PREVIEW_HARD_RELOAD_CHANNEL,
  "desktop.ipc.preview.hardReload",
  (manager, tabId) => manager.hardReload(tabId),
);
const setZoomFactor = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_SET_ZOOM_FACTOR_CHANNEL,
  payload: DesktopPreviewSetZoomFactorInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.setZoomFactor")(function* ({ tabId, zoomFactor }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.setZoomFactor(tabId, zoomFactor);
  }),
});
const setColorScheme = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_SET_COLOR_SCHEME_CHANNEL,
  payload: DesktopPreviewSetColorSchemeInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.setColorScheme")(function* ({ tabId, colorScheme }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.setColorScheme(tabId, colorScheme);
  }),
});
const setAudioMuted = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_SET_AUDIO_MUTED_CHANNEL,
  payload: DesktopPreviewSetAudioMutedInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.setAudioMuted")(function* ({ tabId, audioMuted }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.setAudioMuted(tabId, audioMuted);
  }),
});
const setShown = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_SET_SHOWN_CHANNEL,
  payload: DesktopPreviewSetShownInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.setShown")(function* ({ tabId, shown }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.setShown(tabId, shown);
  }),
});
const openDevTools = tabMethod(
  IpcChannels.PREVIEW_OPEN_DEVTOOLS_CHANNEL,
  "desktop.ipc.preview.openDevTools",
  (manager, tabId) => manager.openDevTools(tabId),
);
const cancelPickElement = tabMethod(
  IpcChannels.PREVIEW_CANCEL_PICK_ELEMENT_CHANNEL,
  "desktop.ipc.preview.cancelPickElement",
  (manager, tabId) => manager.cancelPickElement(tabId),
);
export const startRecording = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_RECORDING_START_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  // Void encodes any value as undefined, so the tagged failure must be tried first.
  result: Schema.Union([PreviewCaptureFailure, Schema.Void]),
  handler: Effect.fn("desktop.ipc.preview.startRecording")(function* ({ tabId }) {
    const manager = yield* PreviewManager.PreviewManager;
    const store = yield* DesktopClientSettings.DesktopClientSettings;
    const settings = yield* store.get;
    const options = Option.map(settings, (value) => ({
      showKeyPresses: value.browserRecordingShowKeyPresses,
      showMousePresses: value.browserRecordingShowMousePresses,
    }));
    return yield* manager
      .startRecording(tabId, Option.getOrUndefined(options))
      .pipe(
        Effect.catch((error) => Effect.succeed(normalizeCaptureFailure(error, "recording-start"))),
      );
  }),
});
const stopRecording = tabMethod(
  IpcChannels.PREVIEW_RECORDING_STOP_CHANNEL,
  "desktop.ipc.preview.stopRecording",
  (manager, tabId) => manager.stopRecording(tabId),
);
const openPictureInPicture = tabMethod(
  IpcChannels.PREVIEW_PICTURE_IN_PICTURE_OPEN_CHANNEL,
  "desktop.ipc.preview.openPictureInPicture",
  (manager, tabId) => manager.openPictureInPicture(tabId),
);
const closePictureInPicture = tabMethod(
  IpcChannels.PREVIEW_PICTURE_IN_PICTURE_CLOSE_CHANNEL,
  "desktop.ipc.preview.closePictureInPicture",
  (manager, tabId) => manager.closePictureInPicture(tabId),
);

const clearCookies = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CLEAR_COOKIES_CHANNEL,
  payload: DesktopPreviewClearDataInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.clearCookies")(function* ({ environmentId, profileId }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.clearCookies(yield* resolveClearPartitions(manager, environmentId, profileId));
  }),
});

const clearCache = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CLEAR_CACHE_CHANNEL,
  payload: DesktopPreviewClearDataInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.clearCache")(function* ({ environmentId, profileId }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.clearCache(yield* resolveClearPartitions(manager, environmentId, profileId));
  }),
});

/** Keep the default profile's bare environment id so existing logins retain their partition. */
export function resolvePartitionScope(
  environmentId: string,
  profileId: string | undefined,
): {
  readonly scope: string;
  readonly persistent: boolean;
  readonly namespace?: "profile";
} {
  if (profileId === undefined || profileId === DEFAULT_BROWSER_PROFILE_ID) {
    return { scope: environmentId, persistent: true };
  }
  // JSON framing preserves lone UTF-16 surrogates; URI encoding throws and replacement would collide.
  return {
    scope: JSON.stringify([environmentId, profileId]),
    persistent: profileId !== INCOGNITO_BROWSER_PROFILE_ID,
    namespace: "profile" as const,
  };
}

/** Omitting a profile clears every partition; a named profile clears only its own partition. */
const resolveClearPartitions = Effect.fn("desktop.ipc.preview.resolveClearPartitions")(function* (
  manager: PreviewManager.PreviewManager["Service"],
  environmentId: string,
  profileId: string | undefined,
) {
  if (profileId === undefined) return undefined;
  const { scope, persistent, namespace } = resolvePartitionScope(environmentId, profileId);
  // getBrowserSession registers the partition; deriving its name alone leaves unopened profiles uncleared.
  yield* manager.getBrowserSession(scope, persistent, namespace);
  return [yield* manager.getBrowserPartition(scope, persistent, namespace)];
});

const getPreviewConfig = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_GET_CONFIG_CHANNEL,
  payload: DesktopPreviewConfigInputSchema,
  result: DesktopPreviewWebviewConfigSchema,
  handler: Effect.fn("desktop.ipc.preview.getConfig")(function* ({ environmentId, profileId }) {
    const manager = yield* PreviewManager.PreviewManager;
    const { scope, persistent, namespace } = resolvePartitionScope(environmentId, profileId);
    // Session creation installs UA and permission handlers before a guest can attach.
    const session = yield* manager.getBrowserSession(scope, persistent, namespace);
    // Content scripts only reach guests that attach after the extension loads.
    yield* (yield* PreviewDashlane.PreviewDashlane).prepareSession(session, profileId);
    return {
      partition: yield* manager.getBrowserPartition(scope, persistent, namespace),
      webPreferences: PREVIEW_WEBVIEW_PREFERENCES,
      preloadUrl: NodeURL.pathToFileURL(`${__dirname}/preview-pick-preload.cjs`).href,
    };
  }),
});

export const listBrowserImportSources = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_IMPORT_SOURCES_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(BrowserImportSource),
  handler: Effect.fn("desktop.ipc.preview.listBrowserImportSources")(function* () {
    const browserImport = yield* BrowserImport.BrowserImport;
    return yield* browserImport.listSources;
  }),
});

export const importBrowserCookies = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_IMPORT_COOKIES_CHANNEL,
  payload: DesktopPreviewImportCookiesInputSchema,
  result: BrowserImportResult,
  handler: Effect.fn("desktop.ipc.preview.importBrowserCookies")(function* ({
    environmentId,
    ...importInput
  }) {
    const browserImport = yield* BrowserImport.BrowserImport;
    const { scope, persistent, namespace } = resolvePartitionScope(
      environmentId,
      importInput.targetProfileId,
    );
    return yield* browserImport.importCookies({
      input: importInput,
      scope,
      persistent,
      ...(namespace === undefined ? {} : { namespace }),
    });
  }),
});

const setAnnotationTheme = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_SET_ANNOTATION_THEME_CHANNEL,
  payload: DesktopPreviewAnnotationThemeInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.setAnnotationTheme")(function* ({ theme }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.setAnnotationTheme(theme);
  }),
});

const pickElement = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_PICK_ELEMENT_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: Schema.NullOr(PreviewAnnotationSubmissionResultSchema),
  handler: Effect.fn("desktop.ipc.preview.pickElement")(function* ({ tabId }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.pickElement(tabId);
  }),
});

const setAnnotationSendEnabled = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_SET_ANNOTATION_SEND_ENABLED_CHANNEL,
  payload: DesktopPreviewAnnotationSendEnabledInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.setAnnotationSendEnabled")(function* ({
    tabId,
    enabled,
  }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.setAnnotationSendEnabled(tabId, enabled);
  }),
});

export const captureScreenshot = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CAPTURE_SCREENSHOT_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: Schema.Union([DesktopPreviewScreenshotArtifactSchema, PreviewCaptureFailure]),
  handler: Effect.fn("desktop.ipc.preview.captureScreenshot")(function* ({ tabId }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager
      .captureScreenshot(tabId)
      .pipe(Effect.catch((error) => Effect.succeed(normalizeCaptureFailure(error, "screenshot"))));
  }),
});

const revealArtifact = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_REVEAL_ARTIFACT_CHANNEL,
  payload: DesktopPreviewArtifactInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.revealArtifact")(function* ({ path }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.revealArtifact(path);
  }),
});

const copyArtifactToClipboard = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_COPY_ARTIFACT_CHANNEL,
  payload: DesktopPreviewArtifactInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.copyArtifactToClipboard")(function* ({ path }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.copyArtifactToClipboard(path);
  }),
});

const saveRecording = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_RECORDING_SAVE_CHANNEL,
  payload: DesktopPreviewRecordingSaveInputSchema,
  result: DesktopPreviewRecordingArtifactSchema,
  handler: Effect.fn("desktop.ipc.preview.saveRecording")(function* ({ tabId, mimeType, data }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.saveRecording(tabId, mimeType, data);
  }),
});

const listExtensionInstallations = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_EXTENSION_INSTALLATIONS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      directory: Schema.String,
      version: Schema.NullOr(Schema.String),
      update: Schema.optional(
        Schema.Struct({
          activity: Schema.Literals(["idle", "checking", "downloading", "updating"]),
          checkedAt: Schema.NullOr(Schema.String),
          readyVersion: Schema.NullOr(Schema.String),
          error: Schema.NullOr(Schema.String),
        }),
      ),
    }),
  ),
  handler: Effect.fn("desktop.ipc.preview.listExtensionInstallations")(function* () {
    return yield* (yield* PreviewDashlane.PreviewDashlane).listInstallations;
  }),
});

const ExtensionTarget = Schema.Struct({ extensionId: Schema.String });

const checkExtensionUpdates = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_EXTENSION_CHECK_UPDATES_CHANNEL,
  payload: ExtensionTarget,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.checkExtensionUpdates")(function* ({ extensionId }) {
    yield* (yield* PreviewDashlane.PreviewDashlane).checkForUpdates(extensionId);
  }),
});

const applyExtensionUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_EXTENSION_APPLY_UPDATE_CHANNEL,
  payload: ExtensionTarget,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.applyExtensionUpdate")(function* ({ extensionId }) {
    yield* (yield* PreviewDashlane.PreviewDashlane).applyUpdate(extensionId);
  }),
});

const ExtensionGuestId = Schema.Int.check(Schema.isGreaterThan(0));

const listExtensionActions = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_EXTENSION_ACTIONS_CHANNEL,
  payload: Schema.Struct({ webContentsId: ExtensionGuestId }),
  result: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      title: Schema.String,
      icon: Schema.NullOr(Schema.String),
    }),
  ),
  handler: Effect.fn("desktop.ipc.preview.listExtensionActions")(function* (
    { webContentsId },
    event,
  ) {
    if (event === undefined) return [];
    const dashlane = yield* PreviewDashlane.PreviewDashlane;
    return yield* dashlane.listActions(event.sender.id, webContentsId);
  }),
});

const AnchorCoordinate = Schema.Finite.check(Schema.isBetween({ minimum: -1e5, maximum: 1e5 }));

const openExtensionPopup = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_EXTENSION_OPEN_POPUP_CHANNEL,
  payload: Schema.Struct({
    webContentsId: ExtensionGuestId,
    extensionId: Schema.String,
    anchor: Schema.Struct({
      x: AnchorCoordinate,
      y: AnchorCoordinate,
      width: AnchorCoordinate,
      height: AnchorCoordinate,
    }),
  }),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.openExtensionPopup")(function* (
    { webContentsId, extensionId, anchor },
    event,
  ) {
    if (event === undefined) return;
    const dashlane = yield* PreviewDashlane.PreviewDashlane;
    yield* dashlane.openPopup(event.sender.id, webContentsId, extensionId, anchor);
  }),
});

export const methods = [
  setForwardedShortcuts,
  createTab,
  closeTab,
  registerWebview,
  navigate,
  goBack,
  goForward,
  refresh,
  zoomIn,
  zoomOut,
  resetZoom,
  hardReload,
  setColorScheme,
  setZoomFactor,
  setAudioMuted,
  setShown,
  openDevTools,
  clearCookies,
  clearCache,
  getPreviewConfig,
  setAnnotationTheme,
  setAnnotationSendEnabled,
  pickElement,
  cancelPickElement,
  captureScreenshot,
  revealArtifact,
  copyArtifactToClipboard,
  openPictureInPicture,
  closePictureInPicture,
  startRecording,
  stopRecording,
  saveRecording,
  listExtensionInstallations,
  checkExtensionUpdates,
  applyExtensionUpdate,
  listExtensionActions,
  openExtensionPopup,
] as const;
