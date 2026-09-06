import { Connection } from "@t3tools/client-runtime/connection";
import { shellSnapshotLoaderLayer } from "@t3tools/client-runtime/state/shell";
import { pullRequestDiffLoaderLayer } from "@t3tools/client-runtime/state/pull-requests";
import {
  threadHistoryWindowLayer,
  threadSnapshotLoaderLayer,
} from "@t3tools/client-runtime/state/threads";
import * as Layer from "effect/Layer";
import { Atom } from "effect/unstable/reactivity";

import { runtimeContextLayer } from "../lib/runtime";
import {
  backgroundActivityObserverLayer,
  backgroundActivityReporterLayer,
} from "../lib/backgroundActivityReporter";
import { connectionPlatformLayer } from "./platform";

const providedConnectionPlatformLayer = connectionPlatformLayer.pipe(
  Layer.provide(runtimeContextLayer),
);

const snapshotLoaderLayer = Layer.mergeAll(
  threadSnapshotLoaderLayer,
  shellSnapshotLoaderLayer,
  pullRequestDiffLoaderLayer,
);
// Web/desktop stay on full thread history: `messageWindowLimit: null` disables
// the legacy message window and the omitted `initialTurnLimit` opts out of turn
// pagination, so the client sends no window parameters and the server returns
// the whole thread (getThreadDetailSnapshot only windows when `turnLimit` is
// present). Revisit once the web timeline can page.
const webThreadHistoryWindowLayer = threadHistoryWindowLayer({
  messageWindowLimit: null,
  messageOlderPageSize: 200,
});

type ConnectionLayerSource =
  | typeof Connection.layer
  | typeof snapshotLoaderLayer
  | typeof webThreadHistoryWindowLayer
  | typeof runtimeContextLayer
  | typeof connectionPlatformLayer
  | typeof backgroundActivityObserverLayer
  | typeof backgroundActivityReporterLayer;

const providedClientConnectionLayer = snapshotLoaderLayer.pipe(
  Layer.provideMerge(
    Connection.layerWithOptions({
      environmentThemes: true,
      usageLimitSources: true,
      usageLimitsCommand: true,
    }),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      runtimeContextLayer,
      providedConnectionPlatformLayer,
      backgroundActivityObserverLayer,
      webThreadHistoryWindowLayer,
    ),
  ),
);

const connectionLayer = backgroundActivityReporterLayer.pipe(
  Layer.provideMerge(providedClientConnectionLayer),
);

export const connectionAtomRuntime: Atom.AtomRuntime<
  Layer.Success<ConnectionLayerSource>,
  Layer.Error<ConnectionLayerSource>
> = Atom.runtime(connectionLayer);
