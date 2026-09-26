import { describe, expect, it } from "@effect/vitest";

import {
  decodeScanCache,
  dedupeWithinFile,
  encodeScanCache,
  pruneScanCache,
  type CachedFile,
  type ScanCache,
} from "./usageScanCache.ts";
import { cacheSavingsUsd, parseRateTable, priceUsage } from "./usagePricing.ts";
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
    fast: false,
    dedupeKey: "msg_1:",
    ...overrides,
  };
}

function position(overrides: Partial<CachedFile["position"]> = {}): CachedFile["position"] {
  return {
    resumeOffset: 120,
    guardLength: 64,
    guardHash: 0xdeadbeef,
    codexState: null,
    ...overrides,
  };
}

function cacheWith(
  entries: readonly [
    path: string,
    mtimeMs: number,
    records: readonly UsageRecord[],
    malformedRecords?: number,
    tailMalformedRecords?: number,
  ][],
): ScanCache {
  const cache: ScanCache = new Map();
  for (const [path, mtimeMs, records, malformedRecords, tailMalformedRecords] of entries) {
    cache.set(path, {
      size: records.length * 10,
      mtimeMs,
      provider: "claude",
      records,
      malformedRecords: malformedRecords ?? 0,
      tailRecords: [],
      tailMalformedRecords: tailMalformedRecords ?? 0,
      position: position(),
    });
  }
  return cache;
}

describe("scan cache round trip", () => {
  it("migrates fork v4 rows without losing completed or tail history", () => {
    const original = cacheWith([["/deleted/session.jsonl", 100, [record()], 2, 3]]);
    const entry = original.get("/deleted/session.jsonl")!;
    original.set("/deleted/session.jsonl", {
      ...entry,
      tailRecords: [record({ dedupeKey: "tail" })],
    });
    const encoded = encodeScanCache(original);
    const files = Object.fromEntries(
      Object.entries(encoded.files).map(([path, file]) => [
        path,
        {
          ...file,
          r: file.r.map((row) => row.slice(0, 10)),
          t: file.t.map((row) => row.slice(0, 10)),
        },
      ]),
    );
    const migrated = decodeScanCache({ ...encoded, version: 4, files });
    const expected = new Map(
      [...original].map(([path, file]) => [path, { ...file, requiresReparse: true }]),
    );
    expect(migrated).toEqual(expected);
    expect(migrated.get("/deleted/session.jsonl")?.records[0]?.fast).toBe(false);
    expect(encodeScanCache(migrated).version).toBe(5);
    expect(decodeScanCache(encodeScanCache(migrated))).toEqual(expected);
  });

  it("preserves Cursor tier pricing and cache savings after serialization", () => {
    const cursor = record({ provider: "cursor", model: "display-name", rateModel: "tiered-rate" });
    const original = cacheWith([["cursor-account:one", 100, [cursor]]]);
    original.set("cursor-account:one", {
      ...original.get("cursor-account:one")!,
      provider: "cursor",
    });
    const restored = decodeScanCache(encodeScanCache(original)).get("cursor-account:one")!
      .records[0]!;
    const rates = parseRateTable({
      "tiered-rate": {
        input_cost_per_token: 0.001,
        output_cost_per_token: 0.002,
        cache_read_input_token_cost: 0.0001,
      },
    });
    expect(restored).toEqual(cursor);
    expect(priceUsage(rates, restored)).toEqual(priceUsage(rates, cursor));
    expect(cacheSavingsUsd(rates, restored)).toBeGreaterThan(0);
    expect(cacheSavingsUsd(rates, restored)).toBe(cacheSavingsUsd(rates, cursor));
  });

  it("restores records unchanged", () => {
    const original = cacheWith([
      [
        "/a.jsonl",
        100,
        [record(), record({ dedupeKey: "msg_2:", model: "claude-opus-5-5", fast: true })],
      ],
      ["/b.jsonl", 200, [record({ sessionId: "session-b", reportedCostUsd: 1.5 })]],
    ]);
    original.set("/grok.jsonl", {
      size: 40,
      mtimeMs: 300,
      provider: "grok",
      records: [
        record({ provider: "grok", model: "grok-4.5-build", dedupeKey: "s:p:grok-4.5-build" }),
      ],
      malformedRecords: 0,
      tailRecords: [record({ provider: "grok", model: "grok-4.5-build", dedupeKey: null })],
      tailMalformedRecords: 0,
      position: position({ resumeOffset: 30, guardLength: 30, guardHash: 123 }),
    });
    original.set("/codex.jsonl", {
      size: 80,
      mtimeMs: 400,
      provider: "codex",
      records: [record({ provider: "codex", model: "gpt-5.2-codex", dedupeKey: null })],
      malformedRecords: 2,
      tailRecords: [],
      tailMalformedRecords: 1,
      position: position({
        codexState: {
          model: "gpt-5.2-codex",
          sessionId: "session-c",
          lastUsageSignature: '{"input_tokens":1}',
          sawSessionMeta: true,
          suppressingForkCopies: false,
          forkCopyAnchorMs: 0,
          deliberateSkips: 4,
        },
      }),
    });

    const restored = decodeScanCache(JSON.parse(JSON.stringify(encodeScanCache(original))));

    expect(restored.size).toBe(4);
    expect(restored.get("/a.jsonl")).toEqual(original.get("/a.jsonl"));
    expect(restored.get("/b.jsonl")).toEqual(original.get("/b.jsonl"));
    expect(restored.get("/grok.jsonl")).toEqual(original.get("/grok.jsonl"));
    expect(restored.get("/codex.jsonl")).toEqual(original.get("/codex.jsonl"));
  });

  it("drops an entry whose persisted parse state is corrupt", () => {
    // Resuming with a bad reducer state would attach appended usage to the
    // wrong model or replay fork-copied history; that entry must cold parse.
    const encoded = encodeScanCache(cacheWith([["/a.jsonl", 100, [record()]]]));
    const poisoned = {
      ...encoded,
      files: {
        "/a.jsonl": { ...encoded.files["/a.jsonl"]!, cs: { model: 42 } },
      },
    };

    expect(decodeScanCache(JSON.parse(JSON.stringify(poisoned))).has("/a.jsonl")).toBe(false);
  });

  it("drops an entry whose guard length is outside the supported range", () => {
    // The guard length sizes a Buffer in the reader; a bogus value would make
    // every parse of that file fail and silently drop its usage.
    const encoded = encodeScanCache(cacheWith([["/a.jsonl", 100, [record()]]]));
    const poisoned = {
      ...encoded,
      files: { "/a.jsonl": { ...encoded.files["/a.jsonl"]!, gl: 1e20 } },
    };

    expect(decodeScanCache(JSON.parse(JSON.stringify(poisoned))).has("/a.jsonl")).toBe(false);
  });

  it("drops an entry whose fast flag is not 0 or 1", () => {
    const encoded = encodeScanCache(cacheWith([["/a.jsonl", 100, [record({ fast: true })]]]));
    const row = encoded.files["/a.jsonl"]!.r[0]!;
    const poisoned = {
      ...encoded,
      files: { "/a.jsonl": { ...encoded.files["/a.jsonl"]!, r: [[...row.slice(0, 10), true]] } },
    };

    expect(decodeScanCache(JSON.parse(JSON.stringify(poisoned))).has("/a.jsonl")).toBe(false);
  });

  it("rejects a document from the previous cache version", () => {
    const encoded = encodeScanCache(cacheWith([["/a.jsonl", 100, [record()]]]));
    const previous = { ...encoded, version: 3 };

    expect(decodeScanCache(JSON.parse(JSON.stringify(previous))).size).toBe(0);
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
    // model, and crash lookupRate at aggregate time.
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

  it("carries completed and tail malformed counts across a round trip", () => {
    // The tail is re-read on resume, so its count must stay separate from
    // completed lines rather than being accumulated again on every scan.
    const original = cacheWith([["/a.jsonl", 100, [record()], 3, 2]]);

    const restored = decodeScanCache(JSON.parse(JSON.stringify(encodeScanCache(original))));

    expect(restored.get("/a.jsonl")?.malformedRecords).toBe(3);
    expect(restored.get("/a.jsonl")?.tailMalformedRecords).toBe(2);
  });

  it("rejects a cache written before entries carried a malformed count", () => {
    // A v1 entry cannot say how many of its lines failed to parse, and
    // reporting those files as clean is worse than one cold re-parse.
    const encoded = encodeScanCache(cacheWith([["/a.jsonl", 100, [record()], 2]]));
    const previousVersion = { ...encoded, version: 1 };

    expect(decodeScanCache(JSON.parse(JSON.stringify(previousVersion))).size).toBe(0);
  });

  it("drops an entry whose malformed counts are missing or nonsensical", () => {
    const encoded = encodeScanCache(cacheWith([["/good.jsonl", 100, [record()], 1]]));
    const good = encoded.files["/good.jsonl"]!;
    const withBadCounts = {
      ...encoded,
      files: {
        ...encoded.files,
        "/missing.jsonl": { ...good, x: undefined },
        "/negative.jsonl": { ...good, x: -1 },
        "/negative-tail.jsonl": { ...good, tx: -1 },
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

    const removed = pruneScanCache(cache, retentionCutoffMs);

    expect(removed).toBe(1);
    expect(cache.size).toBe(0);
  });

  it("keeps entries whose file has disappeared", () => {
    const cache = cacheWith([["/gone.jsonl", 5000, [record()]]]);

    pruneScanCache(cache, retentionCutoffMs);

    expect(cache.size).toBe(1);
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
