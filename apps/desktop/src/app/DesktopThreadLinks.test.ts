// @effect-diagnostics nodeBuiltinImport:off -- A Node EventEmitter stands in for Electron's app events.
import * as NodeEvents from "node:events";

import type { DesktopThreadLink } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { DESKTOP_THREAD_LINK_OPEN_CHANNEL } from "../ipc/channels.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopThreadLinks from "./DesktopThreadLinks.ts";

const THREAD_ID = "8f0e2a4c-7a1b-4c3d-9e5f-0123456789ab";
const DEV_LINK = `t3code-dev://app/primary/${THREAD_ID}`;

function openUrl(app: NodeEvents.EventEmitter, url: string) {
  const preventDefault = vi.fn();
  app.emit("open-url", { preventDefault }, url);
  return preventDefault;
}

describe("parseDesktopThreadLink", () => {
  it("accepts exactly /<environmentId>/<threadId> on the app host", () => {
    assert.deepEqual(DesktopThreadLinks.parseDesktopThreadLink(DEV_LINK, "t3code-dev"), {
      environmentId: "primary",
      threadId: THREAD_ID,
    });
    assert.deepEqual(
      DesktopThreadLinks.parseDesktopThreadLink("t3code://app/env-1/thread-1", "t3code"),
      { environmentId: "env-1", threadId: "thread-1" },
    );
  });

  it("accepts imported thread ids, literal or percent-encoded", () => {
    const expected = { environmentId: "primary", threadId: "import:codex:0199-abc" };
    for (const url of [
      "t3code-dev://app/primary/import:codex:0199-abc",
      "t3code-dev://app/primary/import%3Acodex%3A0199-abc",
    ]) {
      assert.deepEqual(DesktopThreadLinks.parseDesktopThreadLink(url, "t3code-dev"), expected);
    }
  });

  it("rejects everything else", () => {
    for (const url of [
      DEV_LINK.replace("t3code-dev:", "t3code:"),
      "t3code-dev://app/",
      "t3code-dev://app/primary",
      `t3code-dev://app/primary/${THREAD_ID}/`,
      `t3code-dev://app/primary/${THREAD_ID}/extra`,
      `t3code-dev://other/primary/${THREAD_ID}`,
      `t3code-dev://app:8080/primary/${THREAD_ID}`,
      `t3code-dev://user@app/primary/${THREAD_ID}`,
      `${DEV_LINK}?next=/etc/passwd`,
      `${DEV_LINK}#fragment`,
      "t3code-dev://app/primary/%2E%2E",
      "t3code-dev://app/prim%20ary/thread",
      "t3code-dev://app/primary/a%2Fb",
      "t3code-dev://app/primary/a%5Cb",
      "t3code-dev://app/primary/%E0%A4%A",
      `https://app/primary/${THREAD_ID}`,
      "not a url",
    ]) {
      assert.isNull(DesktopThreadLinks.parseDesktopThreadLink(url, "t3code-dev"), url);
    }
  });
});

describe("DesktopThreadLinkInbox", () => {
  it("holds a cold-start open-url until attached and leaves OAuth callbacks alone", () => {
    const app = new NodeEvents.EventEmitter();
    const inbox = new DesktopThreadLinks.DesktopThreadLinkInbox(app, ["/Applications/T3 Code"]);

    const oauthPreventDefault = openUrl(app, "t3code-dev://app/?code=abc");
    const linkPreventDefault = openUrl(app, DEV_LINK);
    assert.strictEqual(oauthPreventDefault.mock.calls.length, 0);
    assert.strictEqual(linkPreventDefault.mock.calls.length, 1);

    const delivered: string[] = [];
    inbox.attach((url) => delivered.push(url));
    assert.deepEqual(delivered, [DEV_LINK]);

    openUrl(app, "t3code-dev://app/env-2/thread-2");
    assert.deepEqual(delivered, [DEV_LINK, "t3code-dev://app/env-2/thread-2"]);
  });

  it("delivers every link received before attaching, in order", () => {
    const app = new NodeEvents.EventEmitter();
    const inbox = new DesktopThreadLinks.DesktopThreadLinkInbox(app, []);
    openUrl(app, "t3code-dev://app/env-1/thread-1");
    openUrl(app, DEV_LINK);

    const delivered: string[] = [];
    inbox.attach((url) => delivered.push(url));
    assert.deepEqual(delivered, ["t3code-dev://app/env-1/thread-1", DEV_LINK]);
  });

  it("reads the first-launch argv and second-instance argv", () => {
    const app = new NodeEvents.EventEmitter();
    const inbox = new DesktopThreadLinks.DesktopThreadLinkInbox(app, [
      "/opt/T3 Code/t3code",
      "--no-sandbox",
      DEV_LINK,
    ]);
    const delivered: string[] = [];
    inbox.attach((url) => delivered.push(url));
    assert.deepEqual(delivered, [DEV_LINK]);

    app.emit("second-instance", {}, ["/opt/T3 Code/t3code", "t3code-dev://app/env-2/thread-2"]);
    app.emit("second-instance", {}, ["/opt/T3 Code/t3code", "t3code-dev://app/?code=abc"]);
    app.emit("second-instance", {}, ["/opt/T3 Code/t3code"]);
    assert.deepEqual(delivered, [DEV_LINK, "t3code-dev://app/env-2/thread-2"]);
  });
});

describe("DesktopThreadLinkQueue", () => {
  it("sends the latest link once a renderer is ready", () => {
    const queue = new DesktopThreadLinks.DesktopThreadLinkQueue();
    const sent: DesktopThreadLink[] = [];
    queue.enqueue({ environmentId: "env-1", threadId: "thread-1" });
    queue.enqueue({ environmentId: "env-2", threadId: "thread-2" });
    queue.setRenderer((link) => sent.push(link));
    queue.enqueue({ environmentId: "env-3", threadId: "thread-3" });
    assert.deepEqual(sent, [
      { environmentId: "env-2", threadId: "thread-2" },
      { environmentId: "env-3", threadId: "thread-3" },
    ]);
  });

  it("keeps a link whose send failed for the next renderer", () => {
    const queue = new DesktopThreadLinks.DesktopThreadLinkQueue();
    queue.setRenderer(() => {
      throw new Error("renderer gone");
    });
    queue.enqueue({ environmentId: "env-1", threadId: "thread-1" });
    const sent: DesktopThreadLink[] = [];
    queue.setRenderer((link) => sent.push(link));
    assert.deepEqual(sent, [{ environmentId: "env-1", threadId: "thread-1" }]);
  });
});

describe("DesktopThreadLinks", () => {
  it.effect("reveals the window and navigates the renderer once it is ready", () => {
    const app = new NodeEvents.EventEmitter();
    const inbox = new DesktopThreadLinks.DesktopThreadLinkInbox(app, []);
    const webContents = Object.assign(new NodeEvents.EventEmitter(), {
      isDestroyed: () => false,
      send: vi.fn(),
    });
    const activate = vi.fn();
    const layer = DesktopThreadLinks.layer(inbox).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
            usesDevelopmentIdentity: true,
          } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
          Layer.succeed(DesktopWindow.DesktopWindow, {
            activate: Effect.sync(activate),
          } as unknown as DesktopWindow.DesktopWindow["Service"]),
          Layer.succeed(ElectronWindow.ElectronWindow, {
            main: Effect.succeedSome({ webContents }),
          } as unknown as ElectronWindow.ElectronWindow["Service"]),
        ),
      ),
    );

    return Effect.gen(function* () {
      const threadLinks = yield* DesktopThreadLinks.DesktopThreadLinks;
      // macOS cold start: the link lands before the service starts.
      openUrl(app, DEV_LINK);
      // A production-scheme link is not this build's.
      openUrl(app, "t3code://app/env-1/thread-1");
      yield* threadLinks.start;
      yield* Effect.yieldNow;
      assert.strictEqual(activate.mock.calls.length, 1);
      assert.strictEqual(webContents.send.mock.calls.length, 0);

      yield* threadLinks.setRendererReady(true);
      assert.deepEqual(webContents.send.mock.calls, [
        [DESKTOP_THREAD_LINK_OPEN_CHANNEL, { environmentId: "primary", threadId: THREAD_ID }],
      ]);

      // A reload or crash drops the renderer; the next link waits for it to be ready again.
      for (const [event, payload] of [
        ["did-start-navigation", { isMainFrame: true, isSameDocument: false }],
        ["render-process-gone", { reason: "crashed" }],
      ] as const) {
        const sentBefore = webContents.send.mock.calls.length;
        webContents.emit(event, payload);
        app.emit("second-instance", {}, ["t3code", `t3code-dev://app/env-2/${event}`]);
        assert.strictEqual(webContents.send.mock.calls.length, sentBefore);
        yield* threadLinks.setRendererReady(true);
        assert.deepEqual(webContents.send.mock.calls[sentBefore], [
          DESKTOP_THREAD_LINK_OPEN_CHANNEL,
          { environmentId: "env-2", threadId: event },
        ]);
      }
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("reveals the window once while an activation is still running", () => {
    const app = new NodeEvents.EventEmitter();
    const inbox = new DesktopThreadLinks.DesktopThreadLinkInbox(app, []);
    const activate = vi.fn();
    const layer = DesktopThreadLinks.layer(inbox).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
            usesDevelopmentIdentity: true,
          } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
          Layer.succeed(DesktopWindow.DesktopWindow, {
            activate: Effect.suspend(() => {
              activate();
              return Effect.never;
            }),
          } as unknown as DesktopWindow.DesktopWindow["Service"]),
          Layer.succeed(ElectronWindow.ElectronWindow, {
            main: Effect.succeedNone,
          } as unknown as ElectronWindow.ElectronWindow["Service"]),
        ),
      ),
    );

    return Effect.gen(function* () {
      const threadLinks = yield* DesktopThreadLinks.DesktopThreadLinks;
      yield* threadLinks.start;
      openUrl(app, "t3code-dev://app/env-1/thread-1");
      yield* Effect.yieldNow;
      openUrl(app, DEV_LINK);
      yield* Effect.yieldNow;
      assert.strictEqual(activate.mock.calls.length, 1);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });
});
