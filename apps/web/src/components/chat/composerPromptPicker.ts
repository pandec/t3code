import type { SavedPrompt } from "@t3tools/contracts/settings";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";

const PICKER_LIMIT = 12;

/**
 * Saved prompts the `/prompt` picker offers. Unfiltered, the library's own
 * order (the order prompts were saved in Settings). With a query, title
 * matches rank first, then content matches — both searchable so a prompt is
 * findable by what it says, not only by what it was named.
 */
export function buildSavedPromptPickerEntries(input: {
  readonly prompts: ReadonlyArray<SavedPrompt>;
  readonly query: string;
}): SavedPrompt[] {
  const normalizedQuery = normalizeSearchQuery(input.query);
  if (!normalizedQuery) {
    return input.prompts.slice(0, PICKER_LIMIT);
  }

  const ranked: Array<{ item: SavedPrompt; score: number; tieBreaker: string }> = [];
  for (const prompt of input.prompts) {
    const titleScore = scoreQueryMatch({
      value: prompt.title.toLowerCase(),
      query: normalizedQuery,
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
      fuzzyBase: 100,
      boundaryMarkers: [" ", "-", "_", "/"],
    });
    // Content is a fallback tier: any title match outranks any content match.
    const contentScore =
      titleScore !== null
        ? null
        : scoreQueryMatch({
            value: prompt.content.toLowerCase(),
            query: normalizedQuery,
            exactBase: 200,
            prefixBase: 202,
            boundaryBase: 204,
            includesBase: 206,
            fuzzyBase: 300,
            boundaryMarkers: [" ", "-", "_", "/", "\n"],
          });
    const score = titleScore ?? contentScore;
    if (score === null) continue;
    insertRankedSearchResult(
      ranked,
      { item: prompt, score, tieBreaker: prompt.title.toLowerCase() },
      PICKER_LIMIT,
    );
  }
  return ranked.map((result) => result.item);
}

/** The picker row's one-line content preview. */
export function savedPromptPreview(prompt: SavedPrompt): string {
  return prompt.content.split("\n", 1)[0] ?? "";
}
