import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";

/** Coarse activity signal for the picker row indicator. */
export type ThreadWaitPickerActivity = "running" | "blocked" | "background" | "idle";

export interface ThreadWaitPickerEntry {
  readonly id: ThreadId;
  readonly title: string;
  readonly activity: ThreadWaitPickerActivity;
  readonly updatedAt: string;
}

const PICKER_LIMIT = 12;
const TITLE_MAX_CHARS = 60;

export function threadWaitPickerActivity(
  thread: Pick<
    EnvironmentThreadShell,
    "session" | "hasPendingApprovals" | "hasPendingUserInput" | "backgroundLiveness"
  >,
): ThreadWaitPickerActivity {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "blocked";
  const status = thread.session?.status;
  if (status === "running" || status === "starting") return "running";
  if (thread.backgroundLiveness === "working" || thread.backgroundLiveness === "monitoring") {
    return "background";
  }
  return "idle";
}

/**
 * Threads the user can pick a wait target from: same environment, not
 * archived, not the thread being composed into. Unfiltered, active threads
 * come first — waiting on an already-idle thread is legal but rarely what
 * the picker is opened for — then most recent activity. With a query the
 * order is title-match quality, recency breaking ties.
 */
export function buildThreadWaitPickerEntries(input: {
  readonly shells: ReadonlyArray<EnvironmentThreadShell>;
  readonly environmentId: EnvironmentId;
  readonly excludeThreadId: ThreadId | null;
  readonly query: string;
}): ThreadWaitPickerEntry[] {
  const candidates = input.shells
    .filter(
      (thread) =>
        thread.environmentId === input.environmentId &&
        thread.archivedAt === null &&
        thread.id !== input.excludeThreadId,
    )
    .map((thread) => ({
      id: thread.id,
      title: thread.title,
      activity: threadWaitPickerActivity(thread),
      updatedAt: thread.updatedAt,
    }));

  const normalizedQuery = normalizeSearchQuery(input.query);
  if (!normalizedQuery) {
    return candidates
      .sort(
        (a, b) =>
          Number(b.activity === "running") - Number(a.activity === "running") ||
          b.updatedAt.localeCompare(a.updatedAt),
      )
      .slice(0, PICKER_LIMIT);
  }

  const ranked: Array<{ item: ThreadWaitPickerEntry; score: number; tieBreaker: string }> = [];
  for (const entry of candidates) {
    const score = scoreQueryMatch({
      value: entry.title.toLowerCase(),
      query: normalizedQuery,
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
      fuzzyBase: 100,
      boundaryMarkers: [" ", "-", "_", "/"],
    });
    if (score === null) continue;
    // Invert updatedAt so the lexicographic tie-breaker prefers recency.
    insertRankedSearchResult(
      ranked,
      { item: entry, score, tieBreaker: invertIsoForRecency(entry.updatedAt) },
      PICKER_LIMIT,
    );
  }
  return ranked.map((result) => result.item);
}

function invertIsoForRecency(iso: string): string {
  let inverted = "";
  for (const char of iso) {
    inverted += char >= "0" && char <= "9" ? String.fromCharCode(105 - char.charCodeAt(0)) : char;
  }
  return inverted;
}

/**
 * The inserted prompt fragment. `$t3-cli` loads the CLI skill, the backticked
 * id is what the agent acts on, and the title keeps the message readable to
 * the human. Ends mid-sentence on purpose: the user types "then ..." intent
 * and sends themselves — never auto-sent.
 */
export function buildThreadWaitInsertionText(entry: {
  readonly id: string;
  readonly title: string;
}): string {
  const compactTitle = entry.title.trim().replace(/\s+/g, " ").replaceAll('"', "'");
  const cappedTitle =
    compactTitle.length > TITLE_MAX_CHARS
      ? `${compactTitle.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…`
      : compactTitle;
  const titlePart = cappedTitle.length > 0 ? ` ("${cappedTitle}")` : "";
  return `$t3-cli wait for thread \`${entry.id}\`${titlePart} to finish, then `;
}
