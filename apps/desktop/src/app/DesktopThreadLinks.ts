import type { DesktopThreadLink } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";

import type * as Electron from "electron";

import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { DESKTOP_THREAD_LINK_OPEN_CHANNEL } from "../ipc/channels.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

// Whitespace, control characters, and path separators cannot be in an id.
const INVALID_SEGMENT_CHARACTER = /[\p{C}\s/\\]/u;
const DESKTOP_SCHEMES = [
  ElectronProtocol.getDesktopScheme(false),
  ElectronProtocol.getDesktopScheme(true),
];

// Ids are not one charset: imported threads use `import:<instance>:<session>`.
// So each segment is decoded and rejected only for what cannot be an id.
function decodeLinkSegment(segment: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  if (decoded.length === 0 || decoded.length > 256 || decoded === "." || decoded === "..") {
    return null;
  }
  return INVALID_SEGMENT_CHARACTER.test(decoded) ? null : decoded;
}

/**
 * Parses `<scheme>://app/<environmentId>/<threadId>`. Everything else is not a
 * thread link, including the Clerk OAuth callback at `<scheme>://app/`.
 */
export function parseDesktopThreadLink(rawUrl: string, scheme: string): DesktopThreadLink | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${scheme}:` || url.host !== ElectronProtocol.DESKTOP_HOST) return null;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return null;
  }
  const [leading, rawEnvironmentId, rawThreadId, ...rest] = url.pathname.split("/");
  if (leading !== "" || rest.length > 0) return null;
  const environmentId = rawEnvironmentId === undefined ? null : decodeLinkSegment(rawEnvironmentId);
  const threadId = rawThreadId === undefined ? null : decodeLinkSegment(rawThreadId);
  if (environmentId === null || threadId === null) return null;
  return { environmentId, threadId };
}

const isThreadLinkCandidate = (url: string) =>
  DESKTOP_SCHEMES.some((scheme) => parseDesktopThreadLink(url, scheme) !== null);

/** The last argument that looks like a thread link for either desktop scheme. */
export function findThreadLinkArgument(argv: ReadonlyArray<unknown>): string | null {
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    const argument = argv[index];
    if (typeof argument === "string" && isThreadLinkCandidate(argument)) return argument;
  }
  return null;
}

/**
 * Receives thread links from the OS before the Effect runtime is up. A macOS
 * cold start delivers the link as `open-url` right after launch, often while
 * layers are still building, so main.ts creates this synchronously. Links wait
 * here until the service attaches.
 */
export class DesktopThreadLinkInbox {
  readonly #pending: string[] = [];
  #deliver: ((url: string) => void) | null = null;

  constructor(app: NodeJS.EventEmitter, argv: ReadonlyArray<string>) {
    // Windows and Linux pass a cold-start link as a launch argument.
    const launchUrl = findThreadLinkArgument(argv);
    if (launchUrl !== null) this.#pending.push(launchUrl);
    app.on("open-url", (event: Electron.Event, url: unknown) => {
      if (typeof url !== "string" || !isThreadLinkCandidate(url)) return;
      event.preventDefault();
      this.#receive(url);
    });
    // Windows and Linux route a link for the running app through the argv of
    // the second instance, which Clerk's single-instance lock then quits.
    app.on("second-instance", (_event: Electron.Event, argv: unknown) => {
      const url = Array.isArray(argv) ? findThreadLinkArgument(argv) : null;
      if (url !== null) this.#receive(url);
    });
  }

  attach(deliver: (url: string) => void): () => void {
    this.#deliver = deliver;
    for (const url of this.#pending.splice(0)) deliver(url);
    return () => {
      if (this.#deliver === deliver) this.#deliver = null;
    };
  }

  #receive(url: string): void {
    if (this.#deliver === null) {
      this.#pending.push(url);
      return;
    }
    this.#deliver(url);
  }
}

/** Holds the latest link until a renderer can navigate; a newer link replaces an unsent one. */
export class DesktopThreadLinkQueue {
  #pending: DesktopThreadLink | null = null;
  #send: ((link: DesktopThreadLink) => void) | null = null;

  enqueue(link: DesktopThreadLink): void {
    this.#pending = link;
    this.#flush();
  }

  setRenderer(send: ((link: DesktopThreadLink) => void) | null): void {
    this.#send = send;
    this.#flush();
  }

  #flush(): void {
    const link = this.#pending;
    const send = this.#send;
    if (link === null || send === null) return;
    this.#pending = null;
    try {
      send(link);
    } catch {
      this.#pending = link;
      this.#send = null;
    }
  }
}

export class DesktopThreadLinks extends Context.Service<
  DesktopThreadLinks,
  {
    /** Delivers buffered and future links. Run once the main window can be revealed. */
    readonly start: Effect.Effect<void, never, Scope.Scope>;
    readonly setRendererReady: (ready: boolean) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopThreadLinks") {}

const { logInfo, logWarning } = makeComponentLogger("desktop-thread-links");

/** @public Service construction is part of the canonical Effect module API. */
export const make = (inbox: DesktopThreadLinkInbox) =>
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    const scheme = ElectronProtocol.getDesktopScheme(environment.usesDevelopmentIdentity);
    const queue = new DesktopThreadLinkQueue();
    let detachRenderer: (() => void) | null = null;
    // Concurrent activations can each find no window and create one.
    let revealing = false;

    const clearRenderer = () => {
      detachRenderer?.();
      detachRenderer = null;
      queue.setRenderer(null);
    };

    const deliver = (url: string) => {
      const link = parseDesktopThreadLink(url, scheme);
      if (link === null) return;
      queue.enqueue(link);
      if (revealing) return;
      revealing = true;
      void runPromise(
        logInfo("opening thread link", { ...link }).pipe(
          Effect.andThen(desktopWindow.activate),
          Effect.catchCause((cause) =>
            logWarning("failed to reveal the window for a thread link", { cause }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              revealing = false;
            }),
          ),
        ),
      );
    };

    return DesktopThreadLinks.of({
      start: Effect.acquireRelease(
        Effect.sync(() => inbox.attach(deliver)),
        (detach) =>
          Effect.sync(() => {
            detach();
            clearRenderer();
          }),
      ).pipe(Effect.asVoid),
      setRendererReady: Effect.fn("DesktopThreadLinks.setRendererReady")(function* (ready) {
        clearRenderer();
        if (!ready) return;
        const main = yield* electronWindow.main;
        if (Option.isNone(main)) return;
        const webContents = main.value.webContents;
        if (webContents.isDestroyed()) return;

        // A reload or crash drops the renderer's listener without a setReady(false).
        // A crashed renderer keeps its webContents, and send() to it fails silently.
        const onNavigation = (
          event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
        ) => {
          if (event.isMainFrame && !event.isSameDocument) clearRenderer();
        };
        webContents.on("did-start-navigation", onNavigation);
        webContents.on("render-process-gone", clearRenderer);
        webContents.once("destroyed", clearRenderer);
        detachRenderer = () => {
          webContents.removeListener("did-start-navigation", onNavigation);
          webContents.removeListener("render-process-gone", clearRenderer);
          webContents.removeListener("destroyed", clearRenderer);
        };
        queue.setRenderer((link) => webContents.send(DESKTOP_THREAD_LINK_OPEN_CHANNEL, link));
      }),
    });
  });

export const layer = (inbox: DesktopThreadLinkInbox) =>
  Layer.effect(DesktopThreadLinks, make(inbox));
