import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { threadVisitHistory } from "./threadLastVisited";
import { resolveVisitTargetAfterPark } from "./threadVisitTargets";

const shells = vi.hoisted(
  () => new Map<string, { archivedAt: string | null; snoozedUntil: string | null }>(),
);
vi.mock("./state/entities", () => ({
  readThreadShell: (ref: { threadId: string }) => shells.get(ref.threadId) ?? null,
}));
vi.mock("./rpc/atomRegistry", () => ({
  appAtomRegistry: { get: () => ({ entries: { get: () => ({ enabled: true }) } }) },
}));
vi.mock("./connection/catalog", () => ({ environmentCatalog: { catalogValueAtom: null } }));
vi.mock("./composerDraftStore", () => ({
  useComposerDraftStore: { getState: () => ({ getDraftSession: () => null }) },
}));

const environmentId = EnvironmentId.make("env");
const ref = (id: string) => scopeThreadRef(environmentId, ThreadId.make(id));
const visit = (id: string) => threadVisitHistory.record({ kind: "server", threadRef: ref(id) });

beforeEach(() => {
  shells.clear();
  for (const id of ["previous", "snoozed"]) {
    shells.set(id, { archivedAt: null, snoozedUntil: null });
  }
  visit("previous");
  visit("snoozed");
});

describe("resolveVisitTargetAfterPark", () => {
  it("returns the thread visited before the snoozed one", () => {
    expect(resolveVisitTargetAfterPark(ref("snoozed"))).toEqual({
      kind: "server",
      threadRef: ref("previous"),
    });
  });

  it("skips a previous thread that is snoozed or snoozing in the same batch", () => {
    shells.set("previous", { archivedAt: null, snoozedUntil: "2999-01-01T00:00:00.000Z" });
    expect(resolveVisitTargetAfterPark(ref("snoozed"))).toBeNull();
    shells.set("previous", { archivedAt: null, snoozedUntil: null });
    expect(
      resolveVisitTargetAfterPark(ref("snoozed"), new Set([scopedThreadKey(ref("previous"))])),
    ).toBeNull();
  });
});
