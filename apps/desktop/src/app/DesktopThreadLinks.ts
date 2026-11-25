import { providerAuthReturnUrl } from "@t3tools/shared/providerAuthReturnUrl";

import * as ElectronProtocol from "../electron/ElectronProtocol.ts";

// Whitespace, control characters, and path separators cannot be in an id.
const INVALID_SEGMENT_CHARACTER = /[\p{C}\s/\\]/u;

// Ids are not one charset: imported threads use `import:<instance>:<session>`.
// So each segment is decoded and rejected only for what cannot be an id.
function decodeLinkSegment(segment: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  if (decoded.length === 0 || decoded.length > 256 || decoded === "." || decoded === "..") {
    return null;
  }
  return INVALID_SEGMENT_CHARACTER.test(decoded) ? null : decoded;
}

/**
 * Fork: rewrites the documented `<scheme>://app/<environmentId>/<threadId>` form as upstream's
 * `<scheme>://threads/…` link. Everything else is not a thread link, including the Clerk OAuth
 * callback at `<scheme>://app/` and the provider sign-in returns under `/settings`.
 */
export function appThreadLinkAsThreadsLink(rawUrl: string, scheme: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${scheme}:` || url.host !== ElectronProtocol.DESKTOP_HOST) return null;
  if (providerAuthReturnUrl(rawUrl) !== undefined) return null;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return null;
  }
  const [leading, rawEnvironmentId, rawThreadId, ...rest] = url.pathname.split("/");
  if (leading !== "" || rest.length > 0) return null;
  const environmentId = rawEnvironmentId === undefined ? null : decodeLinkSegment(rawEnvironmentId);
  const threadId = rawThreadId === undefined ? null : decodeLinkSegment(rawThreadId);
  if (environmentId === null || threadId === null) return null;
  return `${scheme}://threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
}
