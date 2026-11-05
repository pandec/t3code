// @effect-diagnostics globalDate:off globalTimers:off -- Popup focus and toggle timing run in synchronous Electron window handlers.
import {
  DEFAULT_BROWSER_PROFILE_ID,
  browserExtensionRunsInProfile,
  findBrowserProfile,
  resolveBrowserProfiles,
  type BrowserExtensionSettingsById,
  type BrowserProfile,
  type DesktopBrowserExtensionInstallation,
  type DesktopBrowserExtensionUpdate,
  type DesktopPreviewAnchorRect,
  type DesktopPreviewExtensionAction,
} from "@t3tools/contracts";
import type { Rectangle, Session, Size, WebContents } from "electron";
import { BrowserWindow, app, screen, shell, webContents as electronWebContents } from "electron";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { parseSafeExternalUrl } from "../electron/ElectronShell.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import {
  DASHLANE_ACTION_CHANNEL,
  DASHLANE_ACTIVE_TAB_CHANNEL,
  DASHLANE_EXTENSION_ID,
  DASHLANE_OPEN_TAB_CHANNEL,
  DASHLANE_TAB_FOCUS_CHANNEL,
} from "./DashlaneApiShim.ts";
import * as ExtensionPackage from "./ExtensionPackage.ts";

const EXTENSION_NAME = "Dashlane";
const EXTENSION_ORIGIN = `chrome-extension://${DASHLANE_EXTENSION_ID}`;
const POPUP_URL = `${EXTENSION_ORIGIN}/popup/index.html`;
/** Dashlane's Cloudflare Turnstile page; its background needs a token from it before emailing a verification code. */
const CHECK_URL = "https://check.dashlane.com/";
/** Chrome's bounds for an extension popup. */
const POPUP_MIN_SIZE = 25;
const POPUP_MAX_SIZE = { width: 800, height: 600 } as const;
/** A press on the toolbar button blurs and closes its popup before the click arrives; that click only closes. */
const POPUP_TOGGLE_WINDOW_MS = 400;
const UPDATE_STARTUP_DELAY = "30 seconds";
const UPDATE_INTERVAL = "1 day";

/** Chrome derives an extension id from the SHA-256 of its public key, spelled with the letters a-p. */
export const extensionIdFromManifestKey = Effect.fn("PreviewDashlane.extensionIdFromManifestKey")(
  function* (key: string) {
    const crypto = yield* Digest.Digest;
    const hash = yield* crypto.digest(Digest.sha256, yield* Effect.fromResult(Base64.decode(key)));
    return ExtensionPackage.extensionIdFromHash(hash);
  },
);

/** An extension-relative PNG path, or undefined for anything that could leave the extension directory. */
export const extensionAssetPath = (requested: string): ReadonlyArray<string> | undefined => {
  if (!requested.endsWith(".png") || /[\\\0]|:/.test(requested)) return undefined;
  const segments = requested
    .replace(/^\/+/, "")
    .split("/")
    .filter((segment) => segment !== ".");
  return segments.some((segment) => segment === "" || segment === "..") ? undefined : segments;
};

/** Chrome shows the largest icon it was given; a single path tries its @2x variant first. */
const actionIconCandidates = (path: unknown): ReadonlyArray<string> => {
  if (typeof path === "string") {
    return path.includes("@2x.") ? [path] : [path.replace(/\.png$/, "@2x.png"), path];
  }
  if (typeof path !== "object" || path === null) return [];
  return Object.entries(path)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .toSorted(([left], [right]) => Number(right) - Number(left))
    .map(([, value]) => value);
};

/** Like Chrome, right-aligns the popup under its button and keeps it on the button's display. */
const placeExtensionPopup = (
  anchor: Rectangle,
  preferred: Size,
  workArea: Rectangle,
): Rectangle => {
  const width = Math.min(Math.max(preferred.width, POPUP_MIN_SIZE), POPUP_MAX_SIZE.width);
  const height = Math.min(Math.max(preferred.height, POPUP_MIN_SIZE), POPUP_MAX_SIZE.height);
  const right = workArea.x + workArea.width;
  const bottom = workArea.y + workArea.height;
  const x = Math.max(workArea.x, Math.min(anchor.x + anchor.width - width, right - width));
  const below = anchor.y + anchor.height;
  const y = below + height <= bottom ? below : Math.max(workArea.y, anchor.y - height);
  return { x: Math.round(x), y: Math.round(y), width, height };
};

const IconPath = Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)]);
const DashlaneManifest = Schema.Struct({
  key: Schema.String,
  manifest_version: Schema.Literal(3),
  version: Schema.String,
  action: Schema.optional(
    Schema.Struct({
      default_icon: Schema.optional(IconPath),
      default_title: Schema.optional(Schema.String),
    }),
  ),
});
type DashlaneManifest = typeof DashlaneManifest.Type;
const decodeDashlaneManifest = Schema.decodeEffect(Schema.fromJsonString(DashlaneManifest));

const TabId = Schema.optional(Schema.Int);
const WorkerAction = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("icon"), path: Schema.optional(IconPath), tabId: TabId }),
  Schema.Struct({ kind: Schema.Literal("title"), title: Schema.String, tabId: TabId }),
  Schema.Struct({ kind: Schema.Literal("openPopup") }),
]);
const decodeWorkerAction = Schema.decodeUnknownOption(WorkerAction);

export class PreviewDashlaneLoadError extends Schema.TaggedError<PreviewDashlaneLoadError>()(
  "PreviewDashlaneLoadError",
  {
    directory: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to load the Dashlane extension from ${this.directory}: ${this.reason}`;
  }
}

export type PreviewDashlaneEvent =
  | { readonly _tag: "ActionsChanged"; readonly webContentsId: number | null }
  | { readonly _tag: "InstallationsChanged" }
  | {
      readonly _tag: "PopupRequested";
      readonly webContentsId: number;
      readonly extensionId: string;
    };

export class PreviewDashlane extends Context.Service<
  PreviewDashlane,
  {
    /** Loads Dashlane into a profile's session when the settings enable it there. */
    readonly prepareSession: (
      session: Session,
      profileId: string | undefined,
    ) => Effect.Effect<void>;
    /** Loads or unloads every prepared session to match the current settings. */
    readonly refreshProfiles: Effect.Effect<void>;
    /** Reports preview tabs the user interacts with to Dashlane, which only analyses tabs Chrome says are highlighted. */
    readonly trackGuest: (guest: WebContents) => void;
    readonly listInstallations: Effect.Effect<ReadonlyArray<DesktopBrowserExtensionInstallation>>;
    /** Asks Chrome's update service for a newer build and downloads it; installs it when nothing has it loaded. */
    readonly checkForUpdates: (extensionId: string) => Effect.Effect<void>;
    /** Unloads Dashlane everywhere, swaps in the downloaded version, and loads it again. */
    readonly applyUpdate: (extensionId: string) => Effect.Effect<void>;
    /** The toolbar actions for a preview guest hosted by `hostId`. */
    readonly listActions: (
      hostId: number,
      guestId: number,
    ) => Effect.Effect<ReadonlyArray<DesktopPreviewExtensionAction>>;
    /** Opens the popup under its toolbar button, outside the preview tabs that agents can drive or record. */
    readonly openPopup: (
      hostId: number,
      guestId: number,
      extensionId: string,
      anchor: DesktopPreviewAnchorRect,
    ) => Effect.Effect<void>;
    readonly subscribe: (
      listener: (event: PreviewDashlaneEvent) => Effect.Effect<void>,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/preview/Dashlane/PreviewDashlane") {}

interface ActionAppearance {
  readonly icon?: string;
  readonly title?: string;
}

/** Chrome's precedence: a tab's own icon or title, then the extension-wide one, then the manifest's. */
interface ActionState {
  readonly directory: string;
  readonly defaults: { readonly icon: string | null; readonly title: string };
  global: ActionAppearance;
  readonly tabs: Map<number, ActionAppearance>;
  /** Latest icon request per tab, so a slow file read cannot overwrite a newer icon. */
  readonly iconRequests: Map<number | undefined, number>;
}

interface Popup {
  readonly window: BrowserWindow;
  readonly session: Session;
  readonly tabId: number;
}

/** @public */
export const make = Effect.gen(function* PreviewDashlaneMake() {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Digest.Digest;
  const httpClient = yield* HttpClient.HttpClient;
  const preloadPath = environment.path.join(environment.dirname, "preview-dashlane-preload.cjs");
  /** Every session a preview tab used, with its profile, so setting changes can load or unload it. */
  const sessions = new Map<Session, string | undefined>();
  const registered = new WeakSet<Session>();
  const mutex = yield* Semaphore.make(1);
  const enabled = new WeakSet<Session>();
  const actions = new WeakMap<Session, ActionState>();
  const iconCache = new Map<string, string>();
  const lastGuests = new WeakMap<Session, WebContents>();
  const highlighted = new WeakMap<Session, number>();
  const listeners = new Set<(event: PreviewDashlaneEvent) => Effect.Effect<void>>();
  let popup: Popup | undefined;
  let dismissed: { readonly tabId: number; readonly at: number } | undefined;
  const pages = new WeakMap<Session, BrowserWindow>();
  const checks = new WeakMap<Session, BrowserWindow>();
  const workerListeners = new WeakMap<
    Session,
    (details: { readonly versionId: number; readonly runningStatus: string }) => void
  >();

  // Electron's worker IPC and window events arrive outside any fiber.
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const runPromise = Effect.runPromiseWith(context);
  const emit = (event: PreviewDashlaneEvent) => {
    for (const listener of listeners) runFork(listener(event));
  };

  // Electron owns userData, so installed versions survive app updates. Siblings of the loaded
  // directory hold a verified download waiting to be swapped in, and the version it replaced
  // until the new one has loaded once.
  const extensionDirectory = (state?: "download" | "pending" | "previous" | "failed") =>
    environment.path.join(
      app.getPath("userData"),
      "browser-extensions",
      state === undefined ? DASHLANE_EXTENSION_ID : `${DASHLANE_EXTENSION_ID}.${state}`,
    );
  const chromeVersion = process.versions.chrome ?? "0.0.0.0";

  const verifyDirectory = Effect.fn("PreviewDashlane.verifyDirectory")(function* (
    directory: string,
  ) {
    const manifest = yield* fileSystem
      .readFileString(environment.path.join(directory, "manifest.json"))
      .pipe(
        Effect.flatMap(decodeDashlaneManifest),
        Effect.mapError(
          (cause) =>
            new PreviewDashlaneLoadError({
              directory,
              reason: "manifest.json is missing, unreadable, or lacks its Web Store key",
              cause,
            }),
        ),
      );
    // Electron assigns an unpacked extension the id of its manifest key; any other key is another extension.
    const id = yield* extensionIdFromManifestKey(manifest.key).pipe(
      Effect.provideService(Digest.Digest, crypto),
      Effect.orElseSucceed(() => undefined),
    );
    if (id !== DASHLANE_EXTENSION_ID) {
      return yield* new PreviewDashlaneLoadError({
        directory,
        reason: `manifest key does not belong to ${DASHLANE_EXTENSION_ID}`,
      });
    }
    return manifest;
  });

  const readVersion = (directory: string) =>
    verifyDirectory(directory).pipe(
      Effect.map((manifest): string | null => manifest.version),
      Effect.orElseSucceed(() => null),
    );

  let update: Omit<DesktopBrowserExtensionUpdate, "readyVersion"> = {
    activity: "idle",
    checkedAt: null,
    error: null,
  };
  const setUpdate = (patch: Partial<typeof update>) => {
    update = { ...update, ...patch };
    emit({ _tag: "InstallationsChanged" });
  };

  const removeDirectory = (directory: string) =>
    fileSystem.remove(directory, { recursive: true, force: true });

  /**
   * Swaps in a downloaded version, or finishes a swap a crash interrupted. Electron reads extension
   * files lazily, so this runs only while no session has Dashlane loaded. Each step is one rename,
   * so any crash leaves a directory that loads or a backup that the next run restores.
   */
  const settleDisk = Effect.gen(function* () {
    const current = extensionDirectory();
    const pending = extensionDirectory("pending");
    const previous = extensionDirectory("previous");
    yield* removeDirectory(extensionDirectory("failed"));
    let installed = yield* readVersion(current);
    if (installed === null && (yield* readVersion(previous)) !== null) {
      yield* removeDirectory(current);
      yield* fileSystem.rename(previous, current);
      installed = yield* readVersion(current);
    }
    if (!(yield* fileSystem.exists(pending))) return;
    const staged = yield* readVersion(pending);
    if (
      staged === null ||
      (installed !== null && ExtensionPackage.compareVersions(staged, installed) <= 0)
    ) {
      return yield* removeDirectory(pending);
    }
    if (installed === null) {
      yield* removeDirectory(current);
    } else if ((yield* readVersion(previous)) !== null) {
      // A backup means the current version has not loaded since the last swap; keep the one that did.
      yield* removeDirectory(current);
    } else {
      yield* removeDirectory(previous);
      yield* fileSystem.rename(current, previous);
    }
    yield* fileSystem.rename(pending, current);
    iconCache.clear();
    yield* Effect.logInfo("Applied Dashlane extension update", { from: installed, to: staged });
  }).pipe(
    Effect.catch((error) => Effect.logWarning("Could not apply the Dashlane update", { error })),
    Effect.withSpan("PreviewDashlane.settleDisk"),
  );

  /** Puts the replaced version back after the new one failed to load. */
  const rollBack = Effect.gen(function* () {
    const current = extensionDirectory();
    const previous = extensionDirectory("previous");
    const failed = extensionDirectory("failed");
    const restored = yield* readVersion(previous);
    if (restored === null) return null;
    yield* removeDirectory(failed);
    if (yield* fileSystem.exists(current)) yield* fileSystem.rename(current, failed);
    yield* fileSystem.rename(previous, current);
    yield* removeDirectory(failed);
    iconCache.clear();
    return restored;
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not restore the previous Dashlane version", { error }).pipe(
        Effect.as(null),
      ),
    ),
    Effect.withSpan("PreviewDashlane.rollBack"),
  );

  const readIcon = Effect.fn("PreviewDashlane.readIcon")(function* (
    directory: string,
    path: unknown,
  ) {
    const root = yield* fileSystem.realPath(directory).pipe(Effect.option);
    if (Option.isNone(root)) return undefined;
    for (const candidate of actionIconCandidates(path)) {
      const segments = extensionAssetPath(candidate);
      if (segments === undefined) continue;
      const file = environment.path.join(directory, ...segments);
      const cached = iconCache.get(file);
      if (cached !== undefined) return cached;
      // A symlink inside the extension must not expose files outside it.
      const real = yield* fileSystem.realPath(file).pipe(Effect.option);
      if (Option.isNone(real) || !real.value.startsWith(root.value + environment.path.sep))
        continue;
      const bytes = yield* fileSystem.readFile(file).pipe(Effect.option);
      if (Option.isNone(bytes)) continue;
      const url = `data:image/png;base64,${Base64.encode(bytes.value)}`;
      iconCache.set(file, url);
      return url;
    }
    return undefined;
  });

  const installActionState = Effect.fn("PreviewDashlane.installActionState")(function* (
    session: Session,
    directory: string,
    manifest: DashlaneManifest,
  ) {
    const icon = yield* readIcon(directory, manifest.action?.default_icon);
    actions.set(session, {
      directory,
      defaults: { icon: icon ?? null, title: manifest.action?.default_title ?? EXTENSION_NAME },
      global: {},
      tabs: new Map(),
      iconRequests: new Map(),
    });
  });

  const setAppearance = (
    state: ActionState,
    tabId: number | undefined,
    appearance: ActionAppearance,
  ) => {
    if (tabId === undefined) state.global = { ...state.global, ...appearance };
    else state.tabs.set(tabId, { ...state.tabs.get(tabId), ...appearance });
    emit({ _tag: "ActionsChanged", webContentsId: tabId ?? null });
  };

  /** Dashlane's in-page prompts ask the background to open the popup for the tab the user just pressed in. */
  const requestPopup = (session: Session) => {
    const guest = lastGuests.get(session);
    if (guest === undefined || guest.isDestroyed() || !enabled.has(session)) return;
    emit({ _tag: "PopupRequested", webContentsId: guest.id, extensionId: DASHLANE_EXTENSION_ID });
  };

  const onWorkerAction = (session: Session, raw: unknown) => {
    const message = decodeWorkerAction(raw);
    const state = actions.get(session);
    if (Option.isNone(message) || state === undefined) return;
    const action = message.value;
    if (action.kind === "openPopup") return requestPopup(session);
    if (action.kind === "title") return setAppearance(state, action.tabId, { title: action.title });
    const request = (state.iconRequests.get(action.tabId) ?? 0) + 1;
    state.iconRequests.set(action.tabId, request);
    void runPromise(readIcon(state.directory, action.path)).then((icon) => {
      if (icon === undefined || actions.get(session) !== state) return;
      if (state.iconRequests.get(action.tabId) !== request) return;
      setAppearance(state, action.tabId, { icon });
    });
  };

  const load = (session: Session, directory: string) => async () => {
    const onWorkerStatus = listenToWorker(session);
    workerListeners.set(session, onWorkerStatus);
    session.serviceWorkers.on("running-status-changed", onWorkerStatus);
    session.registerPreloadScript({
      type: "service-worker",
      id: "t3code-dashlane-service-worker",
      filePath: preloadPath,
      includeGlobs: [`${EXTENSION_ORIGIN}/*`],
    });
    session.registerPreloadScript({
      type: "frame",
      id: "t3code-dashlane-frame",
      filePath: preloadPath,
      includeGlobs: [`${EXTENSION_ORIGIN}/*`],
    });
    registered.add(session);
    const extension = await session.extensions.loadExtension(directory);
    if (extension.id !== DASHLANE_EXTENSION_ID) {
      session.extensions.removeExtension(extension.id);
      throw new Error(`Loaded unexpected extension ${extension.id}`);
    }
    enabled.add(session);
  };

  const readSettings = clientSettings.get.pipe(
    Effect.orElseSucceed(() => Option.none()),
    Effect.map(
      (
        settings,
      ): {
        readonly profiles: ReadonlyArray<BrowserProfile>;
        readonly extensions: BrowserExtensionSettingsById;
      } =>
        Option.match(settings, {
          onNone: () => ({ profiles: resolveBrowserProfiles([]), extensions: {} }),
          onSome: (value) => ({
            profiles: resolveBrowserProfiles(value.browserProfiles),
            extensions: value.browserExtensions,
          }),
        }),
    ),
  );

  const closePopup = () => {
    const current = popup;
    popup = undefined;
    if (current && !current.window.isDestroyed()) current.window.destroy();
  };

  const disable = (session: Session) => {
    const wasEnabled = enabled.has(session);
    if (popup?.session === session) closePopup();
    for (const window of [pages.get(session), checks.get(session)]) {
      if (window && !window.isDestroyed()) window.destroy();
    }
    pages.delete(session);
    checks.delete(session);
    actions.delete(session);
    lastGuests.delete(session);
    highlighted.delete(session);
    enabled.delete(session);
    if (!registered.has(session)) return;
    const onWorkerStatus = workerListeners.get(session);
    if (onWorkerStatus)
      session.serviceWorkers.removeListener("running-status-changed", onWorkerStatus);
    workerListeners.delete(session);
    session.extensions.removeExtension(DASHLANE_EXTENSION_ID);
    for (const preload of session.getPreloadScripts()) {
      if (
        preload.id === "t3code-dashlane-service-worker" ||
        preload.id === "t3code-dashlane-frame"
      ) {
        session.unregisterPreloadScript(preload.id);
      }
    }
    registered.delete(session);
    if (wasEnabled) emit({ _tag: "ActionsChanged", webContentsId: null });
  };

  const loadedAnywhere = () => [...sessions.keys()].some((session) => enabled.has(session));

  const enable = Effect.fn("PreviewDashlane.enable")(function* (session: Session) {
    const first = !loadedAnywhere();
    if (first) yield* settleDisk;
    if (yield* loadInto(session)) {
      // The new version runs, so the one it replaced is no longer needed.
      if (first) yield* removeDirectory(extensionDirectory("previous")).pipe(Effect.ignore);
      return;
    }
    if (!first) return;
    const failedVersion = yield* readVersion(extensionDirectory());
    const restored = yield* rollBack;
    if (restored === null) return;
    setUpdate({
      error: `Dashlane ${failedVersion === null ? "update" : `v${failedVersion}`} did not load, so v${restored} was restored.`,
    });
    yield* loadInto(session);
  });

  const loadInto = Effect.fn("PreviewDashlane.loadInto")(function* (session: Session) {
    const directory = extensionDirectory();
    return yield* verifyDirectory(directory).pipe(
      Effect.tap((manifest) =>
        Effect.logInfo("Loading Dashlane extension", { version: manifest.version }),
      ),
      // The worker may report its first icon while the extension loads.
      Effect.tap((manifest) => installActionState(session, directory, manifest)),
      Effect.andThen(
        Effect.tryPromise({
          try: load(session, directory),
          catch: (cause) =>
            new PreviewDashlaneLoadError({ directory, reason: "Electron rejected it", cause }),
        }),
      ),
      Effect.andThen(Effect.sync(() => emit({ _tag: "ActionsChanged", webContentsId: null }))),
      Effect.as(true),
      // A later tab or setting change retries, for example once the extension is installed.
      Effect.catch((error) =>
        Effect.sync(() => disable(session)).pipe(
          Effect.andThen(Effect.logWarning("Dashlane extension unavailable", { error })),
          Effect.as(false),
        ),
      ),
    );
  });

  const sync = Effect.fn("PreviewDashlane.sync")(function* (
    session: Session,
    profileId: string | undefined,
  ) {
    const settings = yield* readSettings;
    const profile = findBrowserProfile(settings.profiles, profileId ?? DEFAULT_BROWSER_PROFILE_ID);
    if (!browserExtensionRunsInProfile(settings.extensions, DASHLANE_EXTENSION_ID, profile)) {
      disable(session);
    } else if (!enabled.has(session)) {
      yield* enable(session);
    }
  });

  const prepareSession = Effect.fn("PreviewDashlane.prepareSession")(
    function* (session: Session, profileId: string | undefined) {
      sessions.set(session, profileId);
      yield* sync(session, profileId);
    },
    // Electron cannot cancel a load; keep setting changes serialized until its promise settles.
    Effect.uninterruptible,
    mutex.withPermit,
  );

  /** Matches every prepared session to the settings, then applies a download nothing has loaded. */
  const reconcile = Effect.gen(function* () {
    for (const [session, profileId] of sessions) yield* sync(session, profileId);
    if (!loadedAnywhere()) yield* settleDisk;
    // Loading can swap in a download or roll one back, which changes what Settings shows.
    emit({ _tag: "InstallationsChanged" });
  });

  const refreshProfiles = reconcile.pipe(
    Effect.uninterruptible,
    mutex.withPermit,
    Effect.withSpan("PreviewDashlane.refreshProfiles"),
  );

  const readyVersion = Effect.gen(function* () {
    const staged = yield* readVersion(extensionDirectory("pending"));
    const installed = yield* readVersion(extensionDirectory());
    return staged !== null &&
      (installed === null || ExtensionPackage.compareVersions(staged, installed) > 0)
      ? staged
      : null;
  });

  const listInstallations = Effect.gen(function* () {
    const directory = extensionDirectory();
    const version = yield* readVersion(directory);
    return [
      {
        id: DASHLANE_EXTENSION_ID,
        name: EXTENSION_NAME,
        directory,
        version,
        update: { ...update, readyVersion: yield* readyVersion },
      },
    ];
  }).pipe(Effect.withSpan("PreviewDashlane.listInstallations"));

  let checking = false;
  const packageTarget = (version: string) => ({
    extensionId: DASHLANE_EXTENSION_ID,
    version,
    chromeVersion,
  });

  /** Moves a verified unpacked download into place, installing it right away when nothing has it loaded. */
  const stageDownload = Effect.gen(function* () {
    const pending = extensionDirectory("pending");
    yield* removeDirectory(pending);
    yield* fileSystem.rename(extensionDirectory("download"), pending);
    if (!loadedAnywhere()) yield* reconcile;
  }).pipe(Effect.uninterruptible, mutex.withPermit);

  const findUpdate = Effect.fn("PreviewDashlane.findUpdate")(
    function* (onDemand: boolean) {
      const installed = yield* readVersion(extensionDirectory());
      const result = yield* ExtensionPackage.checkForUpdate({
        extensionId: DASHLANE_EXTENSION_ID,
        installedVersion: installed,
        chromeVersion,
        onDemand,
      });
      setUpdate({ checkedAt: DateTime.formatIso(yield* DateTime.now) });
      if (result._tag === "NoUpdate") return;
      if (installed !== null && ExtensionPackage.compareVersions(result.version, installed) <= 0) {
        return;
      }
      if (result.version === (yield* readyVersion)) return;
      setUpdate({ activity: "downloading" });
      const crx = yield* ExtensionPackage.downloadPackage(result);
      const download = extensionDirectory("download");
      yield* removeDirectory(download);
      yield* ExtensionPackage.unpackExtension(crx, packageTarget(result.version), download).pipe(
        Effect.tapError(() => removeDirectory(download).pipe(Effect.ignore)),
      );
      yield* stageDownload;
      yield* Effect.logInfo("Downloaded Dashlane extension update", { version: result.version });
    },
    Effect.provideService(HttpClient.HttpClient, httpClient),
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, environment.path),
  );

  const runCheck = Effect.fn("PreviewDashlane.runCheck")(function* (onDemand: boolean) {
    // One check or download at a time; a second request while one runs is already answered by it.
    if (checking) return;
    checking = true;
    setUpdate({ activity: "checking", error: null });
    yield* findUpdate(onDemand).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Dashlane update check failed", { error }).pipe(
          Effect.andThen(
            Effect.sync(() =>
              setUpdate({
                error: ExtensionPackage.isExtensionPackageError(error)
                  ? error.reason
                  : "Could not write the extension files",
              }),
            ),
          ),
        ),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          checking = false;
          setUpdate({ activity: "idle" });
        }),
      ),
    );
  });

  const checkForUpdates = (extensionId: string) =>
    extensionId === DASHLANE_EXTENSION_ID ? runCheck(true) : Effect.void;

  const applyUpdate = Effect.fn("PreviewDashlane.applyUpdate")(
    function* (extensionId: string) {
      if (extensionId !== DASHLANE_EXTENSION_ID || (yield* readyVersion) === null) return;
      setUpdate({ activity: "updating", error: null });
      for (const session of sessions.keys()) disable(session);
      yield* reconcile;
      setUpdate({ activity: "idle" });
    },
    Effect.uninterruptible,
    mutex.withPermit,
  );

  const scheduledCheck = Effect.gen(function* () {
    const settings = yield* readSettings;
    const wanted = settings.profiles.some((profile) =>
      browserExtensionRunsInProfile(settings.extensions, DASHLANE_EXTENSION_ID, profile),
    );
    // Installing is the user's call from Settings; the schedule only keeps an install current.
    if (!wanted || (yield* readVersion(extensionDirectory())) === null) return;
    yield* runCheck(false);
  });

  yield* Effect.sleep(UPDATE_STARTUP_DELAY).pipe(
    Effect.andThen(scheduledCheck.pipe(Effect.repeat(Schedule.spaced(UPDATE_INTERVAL)))),
    Effect.forkScoped,
  );

  /** A live preview guest of the renderer that asks, with Dashlane running in its session. */
  const ownedGuest = (hostId: number, guestId: number): WebContents | undefined => {
    const guest = electronWebContents.fromId(guestId);
    if (guest === undefined || guest.isDestroyed()) return undefined;
    if (guest.hostWebContents?.id !== hostId || !enabled.has(guest.session)) return undefined;
    return guest;
  };

  const listActions = (hostId: number, guestId: number) =>
    Effect.sync((): ReadonlyArray<DesktopPreviewExtensionAction> => {
      const guest = ownedGuest(hostId, guestId);
      const state = guest ? actions.get(guest.session) : undefined;
      if (guest === undefined || state === undefined) return [];
      const tab = state.tabs.get(guest.id);
      return [
        {
          id: DASHLANE_EXTENSION_ID,
          name: EXTENSION_NAME,
          title: tab?.title ?? state.global.title ?? state.defaults.title,
          icon: tab?.icon ?? state.global.icon ?? state.defaults.icon,
        },
      ];
    });

  const keepOn = (webContents: WebContents, origin: string) => {
    webContents.setWindowOpenHandler(({ url }) => {
      const external = parseSafeExternalUrl(url);
      if (Option.isSome(external)) void shell.openExternal(external.value);
      return { action: "deny" };
    });
    webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith(origin)) event.preventDefault();
    });
  };
  const keepOnExtension = (webContents: WebContents) => keepOn(webContents, `${EXTENSION_ORIGIN}/`);

  /**
   * Closes the popup once focus leaves Dashlane, like Chrome. Its check and web-app windows keep it open,
   * since sign-in moves between them; focus settles on the next window only after this blur.
   */
  const closePopupUnlessFocused = (session: Session) => {
    setTimeout(() => {
      const current = popup;
      if (current === undefined || current.session !== session) return;
      if (current.window.isDestroyed()) {
        popup = undefined;
        return;
      }
      const focused = BrowserWindow.getFocusedWindow();
      if (focused && [current.window, pages.get(session), checks.get(session)].includes(focused)) {
        return;
      }
      dismissed = { tabId: current.tabId, at: Date.now() };
      closePopup();
    }, 0);
  };

  /** Shows a Dashlane page that Chrome would open in a tab, such as its web app, in one window per session. */
  const openPage = (session: Session, url: string): number => {
    const existing = pages.get(session);
    if (existing && !existing.isDestroyed()) {
      void existing.loadURL(url).catch(() => undefined);
      existing.focus();
      return existing.webContents.id;
    }
    const page = new BrowserWindow({
      width: 1100,
      height: 800,
      title: "Dashlane",
      show: false,
      webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    // Not a popup: the shim keeps Chrome's tab behaviour here.
    page.webContents.ipc.on(DASHLANE_ACTIVE_TAB_CHANNEL, (event) => {
      event.returnValue = null;
    });
    keepOnExtension(page.webContents);
    // A popup reusing this page routes it through Chrome's tabs.update, which cannot raise a window.
    page.webContents.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
      if (isMainFrame) page.focus();
    });
    page.on("blur", () => closePopupUnlessFocused(session));
    pages.set(session, page);
    page.once("ready-to-show", () => page.show());
    void page.loadURL(url).catch(() => page.destroy());
    return page.webContents.id;
  };

  /** Like Dashlane in Chrome, replaces any earlier check page before opening a new one. */
  const openCheck = async (session: Session) => {
    const previous = checks.get(session);
    if (previous && !previous.isDestroyed()) previous.destroy();
    const check = new BrowserWindow({
      width: 480,
      height: 640,
      title: "Dashlane security check",
      webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    keepOn(check.webContents, CHECK_URL);
    check.on("blur", () => closePopupUnlessFocused(session));
    checks.set(session, check);
    // Dashlane polls the page for a token once its tab reports complete.
    await check.loadURL(CHECK_URL);
    return { id: check.webContents.id, url: check.webContents.getURL(), status: "complete" };
  };

  const openTab = async (session: Session, url: unknown) => {
    if (typeof url === "string" && url.startsWith(`${EXTENSION_ORIGIN}/`)) {
      return { id: openPage(session, url), url };
    }
    if (url === CHECK_URL) return openCheck(session);
    throw new Error("Dashlane may only open its own pages");
  };

  function listenToWorker(session: Session) {
    return ({
      versionId,
      runningStatus,
    }: {
      readonly versionId: number;
      readonly runningStatus: string;
    }) => {
      if (runningStatus !== "starting") return;
      const worker = session.serviceWorkers.getWorkerFromVersionID(versionId);
      if (worker?.scope !== `${EXTENSION_ORIGIN}/`) return;
      worker.ipc.removeHandler(DASHLANE_OPEN_TAB_CHANNEL);
      worker.ipc.handle(DASHLANE_OPEN_TAB_CHANNEL, (_event, url: unknown) => openTab(session, url));
      worker.ipc.removeAllListeners(DASHLANE_ACTION_CHANNEL);
      worker.ipc.on(DASHLANE_ACTION_CHANNEL, (_event, message: unknown) =>
        onWorkerAction(session, message),
      );
    };
  }

  const showPopup = (guest: WebContents, anchorInHost: DesktopPreviewAnchorRect): void => {
    const session = guest.session;
    const host = guest.hostWebContents;
    const parent = host ? BrowserWindow.fromWebContents(host) : null;
    if (!host || !parent) return;
    const toggled =
      dismissed?.tabId === guest.id && Date.now() - dismissed.at < POPUP_TOGGLE_WINDOW_MS;
    dismissed = undefined;
    if (toggled) return;
    if (popup && !popup.window.isDestroyed() && popup.tabId === guest.id) {
      popup.window.focus();
      return;
    }
    // The popup resolves its tab while loading, so a popup for another tab starts fresh.
    closePopup();
    const content = parent.getContentBounds();
    const zoom = host.getZoomFactor();
    const anchor = {
      x: Math.round(content.x + anchorInHost.x * zoom),
      y: Math.round(content.y + anchorInHost.y * zoom),
      width: Math.round(anchorInHost.width * zoom),
      height: Math.round(anchorInHost.height * zoom),
    };
    let preferred: Size = { width: 380, height: 600 };
    const window = new BrowserWindow({
      ...preferred,
      title: EXTENSION_NAME,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      parent,
      webPreferences: {
        session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        enablePreferredSizeMode: true,
      },
    });
    const place = () => {
      if (window.isDestroyed()) return;
      window.setBounds(
        placeExtensionPopup(anchor, preferred, screen.getDisplayMatching(anchor).workArea),
      );
    };
    window.webContents.on("preferred-size-changed", (_event, size) => {
      preferred = size;
      place();
    });
    window.once("ready-to-show", () => {
      place();
      window.show();
    });
    window.on("blur", () => closePopupUnlessFocused(session));
    window.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || input.key !== "Escape") return;
      event.preventDefault();
      closePopup();
    });
    window.webContents.ipc.on(DASHLANE_ACTIVE_TAB_CHANNEL, (event) => {
      event.returnValue = guest.isDestroyed() ? null : guest.id;
    });
    window.webContents.ipc.handle(DASHLANE_OPEN_TAB_CHANNEL, (event, url: unknown) => {
      if (event.senderFrame !== window.webContents.mainFrame) {
        throw new Error("Only Dashlane's popup may open pages");
      }
      return openTab(session, url);
    });
    popup = { window, session, tabId: guest.id };
    keepOnExtension(window.webContents);
    void window.loadURL(POPUP_URL).catch(() => window.destroy());
  };

  const openPopup = (
    hostId: number,
    guestId: number,
    extensionId: string,
    anchor: DesktopPreviewAnchorRect,
  ) =>
    Effect.sync(() => {
      const guest = ownedGuest(hostId, guestId);
      if (guest !== undefined && extensionId === DASHLANE_EXTENSION_ID) showPopup(guest, anchor);
    });

  const trackGuest = (guest: WebContents): void => {
    const { id, session } = guest;
    // Electron emits no focus events for webview guests, so a press in another tab, or on a new page, stands in.
    guest.on("did-navigate", () => {
      if (highlighted.get(session) === id) highlighted.delete(session);
    });
    guest.on("destroyed", () => {
      const state = actions.get(session);
      state?.tabs.delete(id);
      state?.iconRequests.delete(id);
      if (highlighted.get(session) === id) highlighted.delete(session);
      if (lastGuests.get(session) === guest) lastGuests.delete(session);
      if (popup?.tabId === id) closePopup();
    });
    guest.on("input-event", (_event, input) => {
      if (!["mouseDown", "rawKeyDown", "keyDown"].includes(input.type)) return;
      if (!enabled.has(session)) return;
      lastGuests.set(session, guest);
      if (highlighted.get(session) === id) return;
      highlighted.set(session, id);
      session.serviceWorkers
        .startWorkerForScope(`${EXTENSION_ORIGIN}/`)
        .then((worker) => {
          // The tab or Dashlane may be gone by the time the worker is running.
          if (!guest.isDestroyed() && enabled.has(session)) {
            worker.send(DASHLANE_TAB_FOCUS_CHANNEL, id);
          }
        })
        .catch(() => undefined);
    });
  };

  const subscribe = (listener: (event: PreviewDashlaneEvent) => Effect.Effect<void>) =>
    Effect.acquireRelease(
      Effect.sync(() => void listeners.add(listener)),
      () => Effect.sync(() => void listeners.delete(listener)),
    );

  return PreviewDashlane.of({
    prepareSession,
    refreshProfiles,
    trackGuest,
    listInstallations,
    checkForUpdates,
    applyUpdate,
    listActions,
    openPopup,
    subscribe,
  });
}).pipe(Effect.withSpan("PreviewDashlane.make"));

export const layer = Layer.effect(PreviewDashlane, make);
