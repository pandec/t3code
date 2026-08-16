export const DEFAULT_THREAD_TITLE = "New thread";

/**
 * `titlePinned` marks a title the user set explicitly (today: the CLI's
 * `--title`), which nothing generated may overwrite — including a generation
 * that started before the pin landed.
 */
export function canReplaceThreadTitle(
  currentTitle: string,
  titleSeed?: string,
  titlePinned = false,
): boolean {
  if (titlePinned) return false;
  const trimmedCurrentTitle = currentTitle.trim();
  if (trimmedCurrentTitle === DEFAULT_THREAD_TITLE) {
    return true;
  }

  const trimmedTitleSeed = titleSeed?.trim();
  return trimmedTitleSeed !== undefined && trimmedTitleSeed.length > 0
    ? trimmedCurrentTitle === trimmedTitleSeed
    : false;
}
