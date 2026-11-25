import { assert, describe, it } from "@effect/vitest";

import * as DesktopThreadLinks from "./DesktopThreadLinks.ts";

const THREAD_ID = "8f0e2a4c-7a1b-4c3d-9e5f-0123456789ab";
const DEV_LINK = `t3code-dev://app/primary/${THREAD_ID}`;
const rewrite = DesktopThreadLinks.appThreadLinkAsThreadsLink;

describe("appThreadLinkAsThreadsLink", () => {
  it("rewrites exactly /<environmentId>/<threadId> on the app host", () => {
    assert.strictEqual(
      rewrite(DEV_LINK, "t3code-dev"),
      `t3code-dev://threads/primary/${THREAD_ID}`,
    );
    assert.strictEqual(
      rewrite("t3code://app/env-1/thread-1", "t3code"),
      "t3code://threads/env-1/thread-1",
    );
  });

  it("accepts imported thread ids, literal or percent-encoded", () => {
    for (const url of [
      "t3code-dev://app/primary/import:codex:0199-abc",
      "t3code-dev://app/primary/import%3Acodex%3A0199-abc",
    ]) {
      assert.strictEqual(
        rewrite(url, "t3code-dev"),
        "t3code-dev://threads/primary/import%3Acodex%3A0199-abc",
      );
    }
  });

  it("rejects everything else", () => {
    for (const url of [
      DEV_LINK.replace("t3code-dev:", "t3code:"),
      "t3code-dev://app/",
      // Provider sign-in returns, routed by DesktopClerk.
      "t3code-dev://app/settings/providers",
      "t3code-dev://app/settings/providers?instanceId=work",
      "t3code-dev://app/welcome",
      "t3code-dev://app/primary",
      `t3code-dev://app/primary/${THREAD_ID}/`,
      `t3code-dev://app/primary/${THREAD_ID}/extra`,
      `t3code-dev://other/primary/${THREAD_ID}`,
      `t3code-dev://app:8080/primary/${THREAD_ID}`,
      `t3code-dev://user@app/primary/${THREAD_ID}`,
      `${DEV_LINK}?next=/etc/passwd`,
      `${DEV_LINK}#fragment`,
      "t3code-dev://app/primary/%2E%2E",
      "t3code-dev://app/prim%20ary/thread",
      "t3code-dev://app/primary/a%2Fb",
      "t3code-dev://app/primary/a%5Cb",
      "t3code-dev://app/primary/%E0%A4%A",
      `https://app/primary/${THREAD_ID}`,
      "not a url",
    ]) {
      assert.isNull(rewrite(url, "t3code-dev"), url);
    }
  });
});
