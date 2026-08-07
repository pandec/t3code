import { Connection } from "@t3tools/client-runtime/connection";
import { shellSnapshotLoaderLayer } from "@t3tools/client-runtime/state/shell";
import {
  threadEventCoalescingLayer,
  threadHistoryWindowLayer,
  threadMessagePageLoaderLayer,
  threadPrewarmRunGateLayer,
  threadPrewarmTriggersLayer,
  threadSnapshotLoaderLayer,
} from "@t3tools/client-runtime/state/threads";
import * as Layer from "effect/Layer";
import { Atom } from "effect/unstable/reactivity";

import { runtimeContextLayer } from "../lib/runtime";
import {
  mobileBackgroundActivityObserverLayer,
  mobileBackgroundActivityReporterLayer,
} from "./background-activity";
import { connectionPlatformLayer } from "./platform";
import { MOBILE_THREAD_HISTORY_WINDOW } from "./thread-history-window";

const providedConnectionPlatformLayer = connectionPlatformLayer.pipe(
  Layer.provide(runtimeContextLayer),
);

const snapshotLoaderLayer = Layer.mergeAll(
  threadSnapshotLoaderLayer,
  threadMessagePageLoaderLayer,
  shellSnapshotLoaderLayer,
);

// Threads hydrate a bounded tail of their message history; older pages load on
// demand as the feed is scrolled up. See MOBILE_THREAD_HISTORY_WINDOW for why
// the phone budget is smaller than the desktop one.
const mobileThreadHistoryWindowLayer = threadHistoryWindowLayer(MOBILE_THREAD_HISTORY_WINDOW);
const mobileThreadEventCoalescingLayer = threadEventCoalescingLayer({
  defaultPriority: "background",
});

type ConnectionLayerSource =
  | typeof Connection.layer
  | typeof snapshotLoaderLayer
  | typeof threadPrewarmTriggersLayer
  | typeof threadPrewarmRunGateLayer
  | typeof mobileThreadHistoryWindowLayer
  | typeof mobileThreadEventCoalescingLayer
  | typeof runtimeContextLayer
  | typeof connectionPlatformLayer
  | typeof mobileBackgroundActivityObserverLayer
  | typeof mobileBackgroundActivityReporterLayer;

const providedClientConnectionLayer = Layer.mergeAll(
  Connection.layer,
  snapshotLoaderLayer,
  threadPrewarmTriggersLayer,
  threadPrewarmRunGateLayer,
  mobileThreadEventCoalescingLayer,
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      runtimeContextLayer,
      providedConnectionPlatformLayer,
      mobileBackgroundActivityObserverLayer,
      mobileThreadHistoryWindowLayer,
    ),
  ),
);

const connectionLayer = mobileBackgroundActivityReporterLayer.pipe(
  Layer.provideMerge(providedClientConnectionLayer),
);

export const connectionAtomRuntime: Atom.AtomRuntime<
  Layer.Success<ConnectionLayerSource>,
  Layer.Error<ConnectionLayerSource>
> = Atom.runtime(connectionLayer);
