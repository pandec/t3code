import type { ThreadGroup } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { matchThreadGroup, normalizeThreadGroupName } from "./threadGroups.ts";

const group = (id: string, name: string, deleted = false): ThreadGroup => ({
  id,
  name,
  orderKey: id,
  revision: `0000000000000001:${id}`,
  deleted,
});

const matchedId = (catalog: ReadonlyArray<ThreadGroup>, query: string) => {
  const match = matchThreadGroup(catalog, query);
  return match.kind === "found" ? match.group.id : match.kind;
};

describe("normalizeThreadGroupName", () => {
  it("drops emoji and collapses spacing", () => {
    assert.equal(normalizeThreadGroupName("🔥 Release  &  🪜 Marketing"), "release & marketing");
    assert.equal(normalizeThreadGroupName("👩🏽‍💻 Dev 1️⃣"), "dev");
    assert.equal(normalizeThreadGroupName("1️⃣Research"), "research");
    assert.equal(normalizeThreadGroupName("🏴󠁧󠁢󠁥󠁮󠁧󠁿 England 🇵🇱"), "england");
    assert.equal(normalizeThreadGroupName("Q4 #launch *"), "q4 #launch *");
  });
});

describe("matchThreadGroup", () => {
  const inbox = group("g-inbox", "📨 Inbox");
  const mailbox = group("g-mailbox", "📬 Inbox");
  const release = group("g-release", "🔥 Release  &  🪜 Marketing");

  it("matches by id, then exact name, then loose name", () => {
    assert.equal(matchedId([inbox, release], "g-inbox"), "g-inbox");
    assert.equal(matchedId([inbox, release], "📨 Inbox"), "g-inbox");
    assert.equal(matchedId([inbox, release], "inbox"), "g-inbox");
    assert.equal(matchedId([inbox, release], " Release & Marketing "), "g-release");
  });

  it("reports loose look-alikes as ambiguous unless the name is exact", () => {
    const match = matchThreadGroup([inbox, mailbox], "Inbox");
    assert.equal(match.kind, "ambiguous");
    if (match.kind === "ambiguous") {
      assert.deepEqual(
        match.candidates.map((candidate) => candidate.id),
        ["g-inbox", "g-mailbox"],
      );
    }
    assert.equal(matchedId([inbox, mailbox], "📬 Inbox"), "g-mailbox");
    assert.equal(matchedId([inbox, mailbox, group("g-plain", "Inbox")], "Inbox"), "g-plain");
  });

  it("ignores deleted groups and emoji-only queries", () => {
    assert.equal(matchedId([group("g-old", "Inbox", true)], "Inbox"), "not-found");
    assert.equal(matchedId([inbox], "📬"), "not-found");
  });
});
