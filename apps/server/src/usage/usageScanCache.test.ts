import { describe, expect, it } from "@effect/vitest";

import {
  decodeScanCache,
  dedupeWithinFile,
  encodeScanCache,
  pruneScanCache,
  type ScanCache,
} from "./usageScanCache.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    provider: "claude",
    timestampMs: 1_786_000_000_000,
    model: "claude-fable-5",
    sessionId: "session-a",
    totals: {
      uncachedInputTokens: 2,
      cachedInputTokens: 1000,
      cacheCreationTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    reportedCostUsd: null,
    dedupeKey: "msg_1:",
    ...overrides,
  };
}

function cacheWith(
  entries: readonly [string, number, readonly UsageRecord[], number?][],
): ScanCache {
  const cache: ScanCache = new Map();
  for (const [path, mtimeMs, records, malformedRecords] of entries) {
    cache.set(path, {
      size: records.length * 10,
      mtimeMs,
      provider: "claude",
      records,
      malformedRecords: malformedRecords ?? 0,
    });
  }
  return cache;
}

describe("scan cache round trip", () => {
  it("restores records unchanged", () => {
    const original = cacheWith([
      ["/a.jsonl", 100, [record(), record({ dedupeKey: "msg_2:", model: "claude-opus-5" })]],
      ["/b.jsonl", 200, [record({ sessionId: "session-b", reportedCostUsd: 1.5 })]],
    ]);

    const restored = decodeScanCache(JSON.parse(JSON.stringify(encodeScanCache(original))));

    expect(restored.size).toBe(2);
    expect(restored.get("/a.jsonl")).toEqual(original.get("/a.jsonl"));
    expect(restored.get("/b.jsonl")).toEqual(original.get("/b.jsonl"));
  });

  it("interns repeated model and session strings", () => {
    const encoded = encodeScanCache(
      cacheWith([["/a.jsonl", 100, [record(), record({ dedupeKey: "msg_2:" }), record()]]]),
    );

    expect(encoded.models).toEqual(["claude-fable-5"]);
    expect(encoded.sessions).toEqual(["session-a"]);
  });

  it("treats a corrupt or foreign document as an empty cache", () => {
    // A bad cache should cost one cold scan, never a broken page.
    expect(decodeScanCache(null).size).toBe(0);
    expect(decodeScanCache("nonsense").size).toBe(0);
    expect(decodeScanCache({ version: 999, models: [], sessions: [], files: {} }).size).toBe(0);
  });

  it("skips malformed file entries but keeps good ones", () => {
    const encoded = encodeScanCache(cacheWith([["/good.jsonl", 100, [record()]]]));
    const withJunk = {
      ...encoded,
      files: { ...encoded.files, "/bad.jsonl": { s: "nope", m: 1, p: "claude", r: [] } },
    };

    const restored = decodeScanCache(JSON.parse(JSON.stringify(withJunk)));
    expect([...restored.keys()]).toEqual(["/good.jsonl"]);
  });

  it("rejects the whole cache when an intern table holds a non-string", () => {
    // models: [1] would pass the undefined guard, put a number in a record's
    // model, and crash normalizeModelName at aggregate time.
    const encoded = encodeScanCache(cacheWith([["/a.jsonl", 100, [record()]]]));
    const poisoned = { ...encoded, models: [1] };

    expect(decodeScanCache(JSON.parse(JSON.stringify(poisoned))).size).toBe(0);
  });

  it("drops the whole entry when any row is corrupt, forcing a cold re-parse", () => {
    // Keeping the surviving rows under the original (size, mtime) would read
    // as a valid warm hit and the file would never be re-parsed.
    const encoded = encodeScanCache(
      cacheWith([["/a.jsonl", 100, [record(), record({ dedupeKey: "msg_2:" })]]]),
    );
    const rows = encoded.files["/a.jsonl"]!.r;
    const poisoned = {
      ...encoded,
      files: {
        "/a.jsonl": {
          ...encoded.files["/a.jsonl"]!,
          r: [rows[0]!, [...rows[1]!.slice(0, 3), "not-a-number", ...rows[1]!.slice(4)]],
        },
      },
    };

    const restored = decodeScanCache(JSON.parse(JSON.stringify(poisoned)));
    expect(restored.has("/a.jsonl")).toBe(false);
  });

  it("carries the malformed record count across a round trip", () => {
    // A warm hit reports the file's damage from the cache, so the count has to
    // survive serialisation or every cached file would look clean.
    const original = cacheWith([["/a.jsonl", 100, [record()], 3]]);

    const restored = decodeScanCache(JSON.parse(JSON.stringify(encodeScanCache(original))));

    expect(restored.get("/a.jsonl")?.malformedRecords).toBe(3);
  });

  it("rejects a cache written before entries carried a malformed count", () => {
    // A v1 entry cannot say how many of its lines failed to parse, and
    // reporting those files as clean is worse than one cold re-parse.
    const encoded = encodeScanCache(cacheWith([["/a.jsonl", 100, [record()], 2]]));
    const previousVersion = { ...encoded, version: 1 };

    expect(decodeScanCache(JSON.parse(JSON.stringify(previousVersion))).size).toBe(0);
  });

  it("drops an entry whose malformed count is missing or nonsensical", () => {
    const encoded = encodeScanCache(cacheWith([["/good.jsonl", 100, [record()], 1]]));
    const good = encoded.files["/good.jsonl"]!;
    const withBadCounts = {
      ...encoded,
      files: {
        ...encoded.files,
        "/missing.jsonl": { s: good.s, m: good.m, p: good.p, r: good.r },
        "/negative.jsonl": { ...good, x: -1 },
      },
    };

    const restored = decodeScanCache(JSON.parse(JSON.stringify(withBadCounts)));
    expect([...restored.keys()]).toEqual(["/good.jsonl"]);
  });
});

describe("pruneScanCache", () => {
  const retentionCutoffMs = 1000;

  it("drops entries older than retention", () => {
    const cache = cacheWith([["/old.jsonl", 500, [record()]]]);

    const removed = pruneScanCache(cache, {
      livePaths: new Set(),
      walkedRoots: ["/"],
      windowStartMs: 400,
      retentionCutoffMs,
    });

    expect(removed).toBe(1);
    expect(cache.size).toBe(0);
  });

  it("drops in-window entries whose file has disappeared", () => {
    const cache = cacheWith([["/gone.jsonl", 5000, [record()]]]);

    pruneScanCache(cache, {
      livePaths: new Set(),
      walkedRoots: ["/"],
      windowStartMs: 4000,
      retentionCutoffMs,
    });

    expect(cache.size).toBe(0);
  });

  it("keeps entries outside the walked window that are still within retention", () => {
    // Viewing 7 days must not evict the 30-day entries, which that walk never
    // looked for and so cannot prove are gone.
    const cache = cacheWith([["/older-but-valid.jsonl", 2000, [record()]]]);

    const removed = pruneScanCache(cache, {
      livePaths: new Set(),
      walkedRoots: ["/"],
      windowStartMs: 4000,
      retentionCutoffMs,
    });

    expect(removed).toBe(0);
    expect(cache.size).toBe(1);
  });

  it("keeps entries the walk saw", () => {
    const cache = cacheWith([["/live.jsonl", 5000, [record()]]]);

    pruneScanCache(cache, {
      livePaths: new Set(["/live.jsonl"]),
      walkedRoots: ["/"],
      windowStartMs: 4000,
      retentionCutoffMs,
    });

    expect(cache.size).toBe(1);
  });
});

describe("pruneScanCache with an unwalked root", () => {
  it("keeps in-window entries for a provider whose directory was not walked", () => {
    // A missing provider root or failed settings read leaves livePaths without
    // that provider's files. Its warm entries must survive the pass.
    const cache = cacheWith([["/codex/sessions/a.jsonl", 5000, [record()]]]);

    const removed = pruneScanCache(cache, {
      livePaths: new Set(),
      walkedRoots: ["/claude/projects"],
      windowStartMs: 4000,
      retentionCutoffMs: 1000,
    });

    expect(removed).toBe(0);
    expect(cache.size).toBe(1);
  });

  it("keeps entries under a sibling root that merely shares the walked root's prefix", () => {
    // "/claude/projects" must not claim "/claude/projects-archive": treating a
    // shared prefix as containment would prune a never-walked root's warm
    // entries as deleted, forcing a cold re-parse of files that still exist.
    const cache = cacheWith([["/claude/projects-archive/a.jsonl", 5000, [record()]]]);

    const removed = pruneScanCache(cache, {
      livePaths: new Set(),
      walkedRoots: ["/claude/projects"],
      windowStartMs: 4000,
      retentionCutoffMs: 1000,
    });

    expect(removed).toBe(0);
    expect(cache.size).toBe(1);
  });

  it("still drops disappeared files under a walked root given with a trailing separator", () => {
    const cache = cacheWith([["/claude/projects/a.jsonl", 5000, [record()]]]);

    const removed = pruneScanCache(cache, {
      livePaths: new Set(),
      walkedRoots: ["/claude/projects/"],
      windowStartMs: 4000,
      retentionCutoffMs: 1000,
    });

    expect(removed).toBe(1);
    expect(cache.size).toBe(0);
  });
});

describe("dedupeWithinFile", () => {
  it("keeps the first record per dedupe key", () => {
    const kept = dedupeWithinFile([
      record({ totals: { ...record().totals, outputTokens: 1 } }),
      record({ totals: { ...record().totals, outputTokens: 999 } }),
      record({ dedupeKey: "msg_2:" }),
    ]);

    expect(kept).toHaveLength(2);
    expect(kept[0]?.totals.outputTokens).toBe(1);
  });

  it("keeps every record that has no dedupe key", () => {
    expect(
      dedupeWithinFile([record({ dedupeKey: null }), record({ dedupeKey: null })]),
    ).toHaveLength(2);
  });
});
