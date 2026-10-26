import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  countSidebarEnvironmentThreads,
  resolveSidebarEnvironmentScope,
  selectPrimaryEnvironmentScope,
  selectRemoteEnvironmentScope,
  sidebarEnvironmentScopeSignature,
  toggleSidebarEnvironmentScope,
} from "./environmentScope";

describe("Sidebar V2 environment scope", () => {
  const environments = [
    { environmentId: "environment-local" },
    { environmentId: "environment-remote" },
  ];

  it("solo-selects from All and returns to All after the last environment is removed", () => {
    const selected = toggleSidebarEnvironmentScope(null, "environment-local");
    expect(selected).toEqual(new Set(["environment-local"]));
    expect(toggleSidebarEnvironmentScope(selected, "environment-local")).toBeNull();
  });

  it("builds an order-independent scope signature", () => {
    expect(
      sidebarEnvironmentScopeSignature(new Set(["environment-remote", "environment-local"])),
    ).toBe(sidebarEnvironmentScopeSignature(new Set(["environment-local", "environment-remote"])));
    expect(sidebarEnvironmentScopeSignature(null)).toBe("all");
  });

  it("resolves current environments without broadening unavailable intent", () => {
    expect(
      resolveSidebarEnvironmentScope(environments, new Set(["environment-local", "missing"])),
    ).toEqual(new Set(["environment-local"]));
    expect(resolveSidebarEnvironmentScope(environments, new Set(["missing"]))).toEqual(new Set());
    expect(resolveSidebarEnvironmentScope(environments, new Set(["missing"]))).not.toBeNull();
    expect(resolveSidebarEnvironmentScope(environments, null)).toBeNull();
  });

  it("returns to All when the last available environment is unticked after another was removed", () => {
    const resolved = resolveSidebarEnvironmentScope(
      [{ environmentId: "environment-local" }],
      new Set(["environment-local", "environment-removed"]),
    );

    expect(toggleSidebarEnvironmentScope(resolved, "environment-local")).toBeNull();
  });

  it("builds primary-only and remote-only quick action scopes", () => {
    expect(selectPrimaryEnvironmentScope("environment-local")).toEqual(
      new Set(["environment-local"]),
    );
    expect(selectPrimaryEnvironmentScope(null)).toBeNull();
    expect(selectRemoteEnvironmentScope(environments, "environment-local")).toEqual(
      new Set(["environment-remote"]),
    );
    expect(selectRemoteEnvironmentScope([environments[0]!], "environment-local")).toBeNull();
  });

  it("refuses to build a remote scope before the primary environment is known", () => {
    // Persisted environments hydrate before the primary registration lands, and
    // every row reads as non-primary in that window. Enumerating then would
    // persist an every-environment scope labelled "remote only" that never
    // corrects itself once the primary arrives.
    expect(selectRemoteEnvironmentScope(environments, null)).toBeNull();
  });
});

describe("countSidebarEnvironmentThreads", () => {
  const environmentId = EnvironmentId.make("environment-local");
  const visible = ProjectId.make("visible");
  const hidden = ProjectId.make("hidden");
  const beforeMs = Date.UTC(2026, 0, 1);
  const shell = (id: string, input: { readonly older?: boolean; readonly archived?: boolean }) => {
    const source = {
      id: ThreadId.make(id),
      projectId: visible,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: ThreadId.make(id),
      },
      settledOverride: input.older === true ? "settled" : null,
      settledAt: input.older === true ? DateTime.makeUnsafe(beforeMs - 1) : null,
    };
    return {
      environmentId,
      projectId: visible,
      archivedAt: input.archived === true ? "2026-02-01T00:00:00.000Z" : null,
      source,
    } as unknown as EnvironmentThreadShell;
  };

  it("adds older settled threads a cold connect left out, without counting paged-in ones twice", () => {
    const olderSettled = new Map([
      [
        environmentId,
        {
          older: {
            before: new Date(beforeMs).toISOString(),
            beforeMs,
            counts: new Map([
              [visible, 5],
              [hidden, 7],
            ]),
          },
        },
      ],
    ]);
    const counts = countSidebarEnvironmentThreads({
      threads: [
        shell("open", {}),
        shell("paged", { older: true }),
        shell("gone", { archived: true }),
      ],
      olderSettled,
      isProjectVisible: (projectKey) => projectKey !== `${environmentId}:${hidden}`,
    });
    // One open row, one paged-in older row, and four older rows still unloaded.
    expect(counts.get(environmentId)).toBe(6);
  });
});
