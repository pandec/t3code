import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  Platform: { select: <T>(options: { default?: T }) => options.default },
  Pressable: "Pressable",
  StyleSheet: { absoluteFill: {} },
  useColorScheme: () => "light",
  useWindowDimensions: () => ({ width: 320, height: 640 }),
  View: "View",
}));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: "SymbolView" }));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../../components/ControlPill", () => ({ ControlPillMenu: "ControlPillMenu" }));
vi.mock("../../components/ProjectFavicon", () => ({ ProjectFavicon: "ProjectFavicon" }));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: "ProviderIcon" }));
vi.mock("../../lib/useThemeColor", () => ({ useThemeColor: () => "#000" }));
// The rows read the selected built-in theme rather than the system color scheme. The real
// provider pulls in uniwind, which this environment cannot transform.
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "light" }),
}));
vi.mock("../../state/use-mobile-preferences", () => ({
  useAccentTintSettings: () => ({ enabled: false, alphas: {} }),
}));
// The listening modules reach expo-audio, which this environment cannot load.
vi.mock("../../state/listeningPlayback", () => ({ useThreadListeningState: () => null }));
vi.mock("../../state/listeningPlayer", () => ({ toggleLoadedListeningTrack: () => {} }));
vi.mock("../../state/use-thread-pr", () => ({ useThreadPr: () => null }));
vi.mock("../home/thread-swipe-actions", () => ({ ThreadSwipeable: "ThreadSwipeable" }));
vi.mock("./thread-search-match", () => ({ ThreadSearchMatchExcerpt: "ThreadSearchMatchExcerpt" }));

import { resolveThreadListV2WorkingTimeLabel } from "./thread-list-v2-items";
import type { ThreadListV2Status } from "./threadListV2";

type WorkingTimeThread = Pick<EnvironmentThreadShell, "latestTurn" | "session">;

const session = (updatedAt: string | null = "2026-06-01T11:30:00.000Z") =>
  updatedAt === null
    ? null
    : {
        threadId: ThreadId.make("thread-1"),
        status: "running" as const,
        providerName: "Codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        runtimeMode: "full-access" as const,
        activeTurnId: TurnId.make("turn-1"),
        lastError: null,
        updatedAt,
      };

const runningTurn = (
  overrides: {
    startedAt?: string | null;
    requestedAt?: string;
    completedAt?: string | null;
  } = {},
) => ({
  turnId: TurnId.make("turn-1"),
  state: "running" as const,
  assistantMessageId: null,
  requestedAt: overrides.requestedAt ?? "2026-06-01T11:40:00.000Z",
  startedAt: overrides.startedAt === undefined ? "2026-06-01T11:50:00.000Z" : overrides.startedAt,
  completedAt: overrides.completedAt === undefined ? null : overrides.completedAt,
});

const thread = (overrides: Partial<WorkingTimeThread> = {}): WorkingTimeThread => ({
  latestTurn: runningTurn(),
  session: session(),
  ...overrides,
});

describe("resolveThreadListV2WorkingTimeLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a companion only for Working", () => {
    expect(resolveThreadListV2WorkingTimeLabel(thread(), "working")).toBe("10m");
    for (const status of [
      "monitoring",
      "approval",
      "input",
      "failed",
      "ready",
    ] as const satisfies readonly ThreadListV2Status[]) {
      expect(resolveThreadListV2WorkingTimeLabel(thread(), status)).toBeNull();
    }
  });

  it("uses startedAt, requestedAt, then session.updatedAt for a running turn", () => {
    expect(resolveThreadListV2WorkingTimeLabel(thread(), "working")).toBe("10m");
    expect(
      resolveThreadListV2WorkingTimeLabel(
        thread({ latestTurn: runningTurn({ startedAt: "malformed" }) }),
        "working",
      ),
    ).toBe("20m");
    expect(
      resolveThreadListV2WorkingTimeLabel(
        thread({
          latestTurn: runningTurn({ startedAt: null, requestedAt: "malformed" }),
        }),
        "working",
      ),
    ).toBe("30m");
  });

  it("uses only session.updatedAt after the turn completes", () => {
    expect(
      resolveThreadListV2WorkingTimeLabel(
        thread({
          latestTurn: runningTurn({ completedAt: "2026-06-01T11:55:00.000Z" }),
        }),
        "working",
      ),
    ).toBe("30m");
  });

  it("returns null when every candidate is missing or malformed", () => {
    expect(
      resolveThreadListV2WorkingTimeLabel(
        thread({
          latestTurn: runningTurn({ startedAt: null, requestedAt: "malformed" }),
          session: session("malformed"),
        }),
        "working",
      ),
    ).toBeNull();
    expect(
      resolveThreadListV2WorkingTimeLabel(thread({ latestTurn: null, session: null }), "working"),
    ).toBeNull();
  });
});
