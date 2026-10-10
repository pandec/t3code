/** Rich messages hold 32,768 characters; the rest is headroom for the part footer. */
export const TELEGRAM_REPORT_PART_CHARS = 32_000;

const HEADING = /^#{1,6}\s/;
const FENCE = /^\s{0,3}(```|~~~)/;

/**
 * Where to end the next part of `text`: the last heading, else blank line, else
 * line boundary within `limit` that is outside a code fence. Headings and blank
 * lines only count past a third of the limit so parts do not come out tiny.
 */
function findCut(text: string, limit: number): number {
  const minPreferredCut = Math.floor(limit / 3);
  let heading = -1;
  let blank = -1;
  let line = -1;
  let fencedLine = -1;
  let inFence = false;
  let offset = 0;
  while (offset <= limit && offset < text.length) {
    const newline = text.indexOf("\n", offset);
    const lineText = text.slice(offset, newline === -1 ? text.length : newline);
    if (offset > 0) {
      if (inFence) {
        fencedLine = offset;
      } else {
        line = offset;
        if (offset >= minPreferredCut) {
          if (HEADING.test(lineText)) heading = offset;
          else if (lineText.trim().length === 0) blank = offset;
        }
      }
    }
    if (FENCE.test(lineText)) inFence = !inFence;
    if (newline === -1) break;
    offset = newline + 1;
  }
  for (const cut of [heading, blank, line, fencedLine]) {
    if (cut > 0) return cut;
  }
  return limit;
}

/**
 * Splits a markdown report into rich-message-sized parts, each ending with an
 * "(n/total)" footer when there is more than one.
 */
export function splitTelegramReport(
  markdown: string,
  limit = TELEGRAM_REPORT_PART_CHARS,
): ReadonlyArray<string> {
  const parts: Array<string> = [];
  let rest = markdown.trim();
  while (rest.length > limit) {
    const cut = findCut(rest, limit);
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest.length > 0) parts.push(rest);
  return parts.length <= 1
    ? parts
    : parts.map((part, index) => `${part}\n\n_(${index + 1}/${parts.length})_`);
}
