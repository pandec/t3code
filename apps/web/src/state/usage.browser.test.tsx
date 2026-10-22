import {
  EnvironmentId,
  UsageDay,
  USAGE_CONTRACT_VERSION,
  type UsageProviderKind,
} from "@t3tools/contracts";
import { useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { useUsage, type EnvironmentUsageStatus, type UsageView } from "./usage";

const testState = vi.hoisted(() => ({ environments: [] as EnvironmentUsageStatus[] }));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => testState.environments,
}));

const input = {
  sinceDay: UsageDay.make("2026-09-04"),
  untilDay: UsageDay.make("2026-09-04"),
  timeZone: "UTC",
};

function environment(
  id: string,
  cost: number | null,
  hostId = id,
  provider: UsageProviderKind = "codex",
): EnvironmentUsageStatus {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    isPending: cost === null,
    canReadDiagnostics: true,
    isConnected: true,
    error: null,
    needsCursorKeychainAccess: false,
    summary:
      cost === null
        ? null
        : {
            ...input,
            contractVersion: USAGE_CONTRACT_VERSION,
            readAt: "2026-09-04T12:00:00Z",
            buckets: [
              {
                day: input.sinceDay,
                provider,
                model: id,
                totals: {
                  uncachedInputTokens: 100,
                  cachedInputTokens: 0,
                  cacheCreationTokens: 0,
                  outputTokens: 50,
                  reasoningTokens: 0,
                },
                costUsd: cost,
                cacheSavingsUsd: 0,
                costSource: "modelPriced",
                records: 1,
                unpricedRecords: 0,
                sessions: 1,
              },
            ],
            sources: [
              {
                fingerprint: {
                  hostId,
                  provider,
                  resolvedHomePath: "/sessions",
                  volumeId: hostId,
                },
                status: "ok",
                scannedFiles: 1,
                skippedFiles: 0,
                malformedRecords: 0,
                distinctSessions: 1,
                message: null,
              },
            ],
            pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
            scanDurationMs: 1,
          },
  };
}

interface ProbeProps {
  selected: ReadonlySet<EnvironmentId> | null;
  hidden?: ReadonlySet<UsageProviderKind>;
  window?: typeof input;
}

function Probe({
  selected,
  hidden,
  window = input,
  onUsage,
}: ProbeProps & { onUsage: (usage: UsageView) => void }) {
  const usage = useUsage(window, selected, hidden === undefined ? {} : { hiddenProviders: hidden });
  useLayoutEffect(() => {
    onUsage(usage);
  }, [onUsage, usage]);
  return null;
}

async function setup() {
  testState.environments = [environment("a", 10), environment("b", 20), environment("slow", null)];
  let latest: UsageView | undefined;
  const onUsage = (usage: UsageView) => {
    latest = usage;
  };
  const screen = await render(<Probe selected={null} onUsage={onUsage} />);
  const show = (props: ProbeProps) => screen.rerender(<Probe {...props} onUsage={onUsage} />);
  return {
    get latest() {
      return latest!;
    },
    show,
    select: (...ids: string[]) =>
      show({ selected: new Set(ids.map((id) => EnvironmentId.make(id))) }),
    [Symbol.asyncDispose]: () => screen[Symbol.asyncDispose](),
  };
}

describe("usage provider filter", () => {
  it("filters the classified summary and gateway-credited pools", async () => {
    await using screen = await setup();
    // Fork: the atom sets `state`, which the merge reads before `summary`.
    const reported = (status: EnvironmentUsageStatus): EnvironmentUsageStatus => ({
      ...status,
      state: { kind: "reported", summary: status.summary! },
    });
    const gateway = environment("c", 5, "c", "claude");
    testState.environments = [
      reported(environment("a", 10)),
      reported({
        ...gateway,
        summary: {
          ...gateway.summary!,
          buckets: gateway.summary!.buckets.map((bucket) => ({ ...bucket, model: "gpt-5" })),
        },
      }),
    ];
    // Under pool attribution the Claude transcript's GPT usage spends Codex.
    await screen.show({ selected: null, hidden: new Set(["codex"]) });
    expect(screen.latest.merged.costUsd).toBe(0);
    expect(screen.latest.visibleEnvironments.flatMap((env) => env.summary?.buckets ?? [])).toEqual(
      [],
    );

    // Hiding the scanning app keeps what it spent from a visible subscription.
    await screen.show({ selected: null, hidden: new Set(["claude"]) });
    expect(screen.latest.merged.costUsd).toBe(15);
    expect(screen.latest.merged.providers.map((entry) => entry.provider)).toEqual(["codex"]);
  });
});
