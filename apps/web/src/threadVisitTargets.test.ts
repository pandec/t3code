import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { threadVisitHistory } from "./threadLastVisited";
import { resolveVisitTarget, resolveVisitTargetAfterPark } from "./threadVisitTargets";

const shells = vi.hoisted(
  () => new Map<string, { archivedAt: string | null; snoozedUntil: string | null }>(),
);
vi.mock("./state/entities", () => ({
  readThreadShell: (ref: { threadId: string }) => shells.get(ref.threadId) ?? null,
}));
const shellState = vi.hoisted(() => ({
  olderSettledCut: true,
  removed: new Set<string>(),
}));
vi.mock("./rpc/atomRegistry", () => ({
  appAtomRegistry: { get: (atom: { read: () => unknown }) => atom.read() },
}));
vi.mock("./connection/catalog", () => ({
  environmentCatalog: {
    catalogValueAtom: { read: () => ({ entries: { get: () => ({ enabled: true }) } }) },
  },
}));
vi.mock("./state/shell", () => ({
  environmentShell: {
    stateAtom: () => ({
      read: () =>
        AsyncResult.success({
          snapshot: Option.some(
            shellState.olderSettledCut ? { olderSettled: { before: "2026-01-01" } } : {},
          ),
          removedAt: new Map([...shellState.removed].map((id) => [id, 1])),
        }),
    }),
  },
}));
vi.mock("./composerDraftStore", () => ({
  useComposerDraftStore: { getState: () => ({ getDraftSession: () => null }) },
}));

const environmentId = EnvironmentId.make("env");
const ref = (id: string) => scopeThreadRef(environmentId, ThreadId.make(id));
const visit = (id: string) => threadVisitHistory.record({ kind: "server", threadRef: ref(id) });

beforeEach(() => {
  shells.clear();
  shellState.olderSettledCut = true;
  shellState.removed.clear();
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

describe("older settled threads without a loaded shell", () => {
  it("stay openable after a cold connect leaves them out", () => {
    shells.delete("previous");
    expect(resolveVisitTarget({ kind: "server", threadRef: ref("previous") })).toEqual({
      kind: "server",
      threadRef: ref("previous"),
    });
    expect(resolveVisitTargetAfterPark(ref("snoozed"))).toEqual({
      kind: "server",
      threadRef: ref("previous"),
    });
  });

  it("are rejected once removed, or when the shell keeps every settled thread", () => {
    shells.delete("previous");
    shellState.removed.add("previous");
    expect(resolveVisitTargetAfterPark(ref("snoozed"))).toBeNull();
    shellState.removed.clear();
    shellState.olderSettledCut = false;
    expect(resolveVisitTargetAfterPark(ref("snoozed"))).toBeNull();
  });
});
