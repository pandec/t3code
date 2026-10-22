import { describe, expect, it } from "@effect/vitest";

import {
  decodeScanCache,
  dedupeWithinFile,
  encodeScanCache,
  makeScanCacheWriter,
  type CachedFile,
  type ScanCache,
} from "./usageScanCache.ts";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";

import type { CodexScanState } from "../provider/Drivers/codexUsage.ts";
import { cacheSavingsUsd, parseRateTable, priceUsage } from "./usagePricing.ts";
import { TEST_FORMAT_MAP } from "./usageTestFormats.ts";
import { initialCodexScanState, parseCodexLine } from "../provider/Drivers/codexUsage.ts";

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
    speed: "standard",
    dedupeKey: "msg_1:",
    ...overrides,
  };
}

function position(overrides: Partial<CachedFile["position"]> = {}): CachedFile["position"] {
  return {
    resumeOffset: 120,
    guardLength: 64,
    guardHash: 0xdeadbeef,
    state: null,
    ...overrides,
  };
}

const MIGRATED_POSITION: CachedFile["position"] = {
  resumeOffset: 0,
  guardLength: 0,
  guardHash: 0,
  state: null,
};

function codexState(): CodexScanState {
  return {
    ...initialCodexScanState(),
    model: "gpt-6-astra",
    speed: "ultrafast",
    sessionId: "session-c",
    sawSessionMeta: true,
    deliberateSkips: 1,
  };
}

/** The Codex state fork v6 and v7 wrote, before counters were reconciled. */
function forkV7CodexState() {
  return {
    model: "gpt-6-astra",
    speed: "ultrafast",
    sessionId: "session-c",
    lastUsageSignature: null,
    sawSessionMeta: true,
    suppressingForkCopies: false,
    forkCopyAnchorMs: 0,
    deliberateSkips: 1,
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
    const migrated = decodeScanCache({ ...encoded, version: 4, files }, TEST_FORMAT_MAP);
    const expected = new Map(
      [...original].map(([path, file]) => [
        path,
        { ...file, requiresReparse: true, position: MIGRATED_POSITION },
      ]),
    );
    expect(migrated).toEqual(expected);
    expect(migrated.get("/deleted/session.jsonl")?.records[0]?.speed).toBe("standard");
    expect(encodeScanCache(migrated).version).toBe(9);
    expect(decodeScanCache(encodeScanCache(migrated), TEST_FORMAT_MAP)).toEqual(expected);
  });

  it("migrates fork v5 with retained totals, re-parsing Claude and Codex", () => {
    const original = cacheWith([["/deleted/claude.jsonl", 100, [record({ speed: "fast" })], 2, 1]]);
    original.set("cursor-account:one", {
      ...original.get("/deleted/claude.jsonl")!,
      provider: "cursor",
      records: [record({ provider: "cursor", model: "display-name", rateModel: "tier" })],
      malformedRecords: 0,
      tailMalformedRecords: 0,
    });
    original.set("/codex.jsonl", {
      ...original.get("/deleted/claude.jsonl")!,
      provider: "codex",
      records: [record({ provider: "codex", model: "gpt-6-astra", dedupeKey: null })],
      position: position({ state: codexState() }),
    });
    const encoded = encodeScanCache(original);
    // Fork v5 wrote the same rows (its `fast` flag is speed index 0 or 1), but
    // its Codex state had no service tier.
    const { speed: _speed, ...forkCodexState } = codexState();
    const forkV5 = {
      ...encoded,
      version: 5,
      files: {
        ...encoded.files,
        "/codex.jsonl": { ...encoded.files["/codex.jsonl"]!, cs: forkCodexState },
      },
    };

    const migrated = decodeScanCache(JSON.parse(JSON.stringify(forkV5)), TEST_FORMAT_MAP);

    expect(migrated.get("/deleted/claude.jsonl")).toEqual({
      ...original.get("/deleted/claude.jsonl")!,
      requiresReparse: true,
      position: MIGRATED_POSITION,
    });
    expect(migrated.get("cursor-account:one")).toEqual(original.get("cursor-account:one"));
    expect(migrated.get("/codex.jsonl")).toEqual({
      ...original.get("/codex.jsonl")!,
      requiresReparse: true,
      position: MIGRATED_POSITION,
    });
    expect(decodeScanCache(encodeScanCache(migrated), TEST_FORMAT_MAP)).toEqual(migrated);
  });

  it("migrates fork v6, re-parsing Claude and Codex but resuming other entries", () => {
    // v6 Claude entries kept a proxied message's placeholder over its real usage.
    const original = cacheWith([["/claude.jsonl", 100, [record()], 2, 1]]);
    original.set("/codex.jsonl", {
      ...original.get("/claude.jsonl")!,
      provider: "codex",
      records: [record({ provider: "codex", model: "gpt-6-astra", dedupeKey: null })],
      position: position({ state: codexState() }),
    });
    original.set("/pi.jsonl", {
      ...original.get("/claude.jsonl")!,
      provider: "pi",
      records: [record({ provider: "pi", model: "anthropic/claude-fable-5" })],
      position: position({ state: { sessionId: "session-a" } }),
    });
    const encoded = encodeScanCache(original);
    const forkV6 = {
      ...encoded,
      version: 6,
      files: {
        ...encoded.files,
        "/codex.jsonl": { ...encoded.files["/codex.jsonl"]!, cs: forkV7CodexState() },
      },
    };

    const migrated = decodeScanCache(JSON.parse(JSON.stringify(forkV6)), TEST_FORMAT_MAP);

    expect(migrated.get("/claude.jsonl")).toEqual({
      ...original.get("/claude.jsonl")!,
      requiresReparse: true,
      position: MIGRATED_POSITION,
    });
    // The pre-reconciliation Codex state cannot resume, but a deleted rollout keeps its records.
    expect(migrated.get("/codex.jsonl")).toEqual({
      ...original.get("/codex.jsonl")!,
      requiresReparse: true,
      position: MIGRATED_POSITION,
    });
    expect(migrated.get("/pi.jsonl")).toEqual(original.get("/pi.jsonl"));
  });

  it("migrates fork v7 provisional and one-hour columns, re-parsing only Codex", () => {
    const provisional = record({
      totals: { ...record().totals, uncachedInputTokens: 0, outputTokens: 0 },
      provisional: true,
    });
    const oneHour = record({ dedupeKey: "b", oneHourCacheCreationTokens: 7 });
    const original = cacheWith([["/claude.jsonl", 100, [provisional, oneHour], 2, 1]]);
    original.set("/deleted/codex.jsonl", {
      ...original.get("/claude.jsonl")!,
      provider: "codex",
      records: [record({ provider: "codex", model: "gpt-6-astra", dedupeKey: null })],
      position: position({ state: codexState() }),
    });
    const encoded = encodeScanCache(original);
    // Fork v7 wrote the same columns, with `provisional` at index 12.
    expect(encoded.files["/claude.jsonl"]!.r.map((row) => row.slice(12))).toEqual([[1], [0, 7]]);
    const forkV7 = {
      ...encoded,
      version: 7,
      files: {
        ...encoded.files,
        "/deleted/codex.jsonl": {
          ...encoded.files["/deleted/codex.jsonl"]!,
          cs: forkV7CodexState(),
        },
      },
    };

    const migrated = decodeScanCache(JSON.parse(JSON.stringify(forkV7)), TEST_FORMAT_MAP);

    expect(migrated.get("/claude.jsonl")).toEqual(original.get("/claude.jsonl"));
    expect(migrated.get("/deleted/codex.jsonl")).toEqual({
      ...original.get("/deleted/codex.jsonl")!,
      requiresReparse: true,
      position: MIGRATED_POSITION,
    });
  });

  it("migrates fork v8 in place, re-parsing only Codex for compaction and resume markers", () => {
    const provisional = record({
      totals: { ...record().totals, uncachedInputTokens: 0, outputTokens: 0 },
      provisional: true,
    });
    const original = cacheWith([["/claude.jsonl", 100, [provisional], 2, 1]]);
    original.set("/deleted/codex.jsonl", {
      ...original.get("/claude.jsonl")!,
      provider: "codex",
      records: [
        record({
          provider: "codex",
          model: "gpt-6-astra",
          dedupeKey: null,
          unresolvedServiceTierTurnId: "turn-1",
        }),
      ],
      position: position({ state: codexState() }),
    });
    original.set("/pi.jsonl", {
      ...original.get("/claude.jsonl")!,
      provider: "pi",
      records: [record({ provider: "pi", model: "anthropic/claude-fable-5" })],
      position: position({ state: { sessionId: "session-a" } }),
    });
    // Fork v8 wrote the current layout, tier turn at index 14.
    const forkV8 = { ...encodeScanCache(original), version: 8 };
    expect(forkV8.files["/deleted/codex.jsonl"]!.r[0]![14]).toBe("turn-1");

    const migrated = decodeScanCache(JSON.parse(JSON.stringify(forkV8)), TEST_FORMAT_MAP);

    expect(migrated.get("/claude.jsonl")).toEqual(original.get("/claude.jsonl"));
    expect(migrated.get("/pi.jsonl")).toEqual(original.get("/pi.jsonl"));
    expect(migrated.get("/deleted/codex.jsonl")).toEqual({
      ...original.get("/deleted/codex.jsonl")!,
      requiresReparse: true,
      position: MIGRATED_POSITION,
    });
  });

  it("round-trips provisional records and one-hour cache writes", () => {
    const provisional = record({
      totals: { ...record().totals, uncachedInputTokens: 0, outputTokens: 0 },
      provisional: true,
    });
    const oneHour = record({ dedupeKey: "b", oneHourCacheCreationTokens: 7 });
    const original = cacheWith([
      ["/claude.jsonl", 100, [provisional, oneHour, record({ dedupeKey: "c" })]],
    ]);
    // Tier provenance follows the fork's columns, whichever of them are set.
    original.set("/codex.jsonl", {
      ...original.get("/claude.jsonl")!,
      provider: "codex",
      records: [
        record({ provider: "codex", dedupeKey: null, unresolvedServiceTierTurnId: "turn-1" }),
        record({
          provider: "codex",
          dedupeKey: null,
          oneHourCacheCreationTokens: 3,
          unresolvedServiceTierTurnId: "turn-2",
        }),
      ],
      position: position({ state: codexState() }),
    });
    const encoded = JSON.parse(JSON.stringify(encodeScanCache(original)));

    expect(encoded.files["/codex.jsonl"].r.map((row: unknown[]) => row.slice(12))).toEqual([
      [0, 0, "turn-1"],
      [0, 3, "turn-2"],
    ]);
    expect(decodeScanCache(encoded, TEST_FORMAT_MAP)).toEqual(original);
  });

  it("migrates upstream v5 rows with their speed, re-parsing for malformed counts", () => {
    const original = cacheWith([["/deleted/claude.jsonl", 100, [record({ speed: "fast" })]]]);
    original.set("/codex.jsonl", {
      ...original.get("/deleted/claude.jsonl")!,
      provider: "codex",
      records: [
        record({ provider: "codex", model: "gpt-6-astra", dedupeKey: null, speed: "ultrafast" }),
      ],
      position: position({ state: codexState() }),
    });
    const encoded = encodeScanCache(original);
    const { deliberateSkips: _skips, ...upstreamCodexState } = codexState();
    const upstreamV5 = {
      ...encoded,
      version: 5,
      files: Object.fromEntries(
        Object.entries(encoded.files).map(([path, { x: _x, tx: _tx, ...file }]) => [
          path,
          {
            ...file,
            r: file.r.map((row) => row.slice(0, 11)),
            t: file.t.map((row) => row.slice(0, 11)),
            cs: file.p === "codex" ? upstreamCodexState : null,
          },
        ]),
      ),
    };

    const migrated = decodeScanCache(JSON.parse(JSON.stringify(upstreamV5)), TEST_FORMAT_MAP);

    expect(migrated).toEqual(
      new Map(
        [...original].map(([path, file]) => [
          path,
          { ...file, requiresReparse: true, position: MIGRATED_POSITION },
        ]),
      ),
    );
    expect(migrated.get("/codex.jsonl")?.records[0]?.speed).toBe("ultrafast");
    expect(migrated.get("/deleted/claude.jsonl")?.records[0]?.speed).toBe("fast");
  });

  it("migrates upstream v4 rows whose speed is a fast flag", () => {
    const original = cacheWith([["/deleted/claude.jsonl", 100, [record({ speed: "fast" })]]]);
    const encoded = encodeScanCache(original);
    const upstreamV4 = {
      ...encoded,
      version: 4,
      files: Object.fromEntries(
        Object.entries(encoded.files).map(([path, { x: _x, tx: _tx, ...file }]) => [
          path,
          { ...file, r: file.r.map((row) => row.slice(0, 11)), t: [] },
        ]),
      ),
    };

    const migrated = decodeScanCache(JSON.parse(JSON.stringify(upstreamV4)), TEST_FORMAT_MAP);

    expect(migrated.get("/deleted/claude.jsonl")?.records).toEqual(
      original.get("/deleted/claude.jsonl")?.records,
    );
    expect(migrated.get("/deleted/claude.jsonl")?.requiresReparse).toBe(true);
  });

  it("preserves Cursor tier pricing and cache savings after serialization", () => {
    const cursor = record({ provider: "cursor", model: "display-name", rateModel: "tiered-rate" });
    const original = cacheWith([["cursor-account:one", 100, [cursor]]]);
    original.set("cursor-account:one", {
      ...original.get("cursor-account:one")!,
      provider: "cursor",
    });
    const restored = decodeScanCache(encodeScanCache(original), TEST_FORMAT_MAP).get(
      "cursor-account:one",
    )!.records[0]!;
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

  it("restores cached history unchanged except for Claude local placeholders", () => {
    const original = cacheWith([
      [
        "/a.jsonl",
        100,
        [record(), record({ dedupeKey: "msg_2:", model: "claude-opus-5-5", speed: "fast" })],
      ],
      [
        "/b.jsonl",
        200,
        [
          record({
            sessionId: "session-b",
            reportedCostUsd: 1.5,
            totals: {
              uncachedInputTokens: 0,
              cachedInputTokens: 0,
              cacheCreationTokens: 0,
              outputTokens: 0,
              reasoningTokens: 0,
            },
          }),
        ],
      ],
    ]);
    original.set("/grok.jsonl", {
      size: 40,
      malformedRecords: 2,
      mtimeMs: 300,
      provider: "grok",
      records: [
        record({ provider: "grok", model: "grok-4.5-build", dedupeKey: "s:p:grok-4.5-build" }),
        record({ provider: "grok", model: "<synthetic>", dedupeKey: "s:p:<synthetic>" }),
      ],
      tailRecords: [record({ provider: "grok", model: "<synthetic>", dedupeKey: null })],
      tailMalformedRecords: 1,
      position: position({ resumeOffset: 30, guardLength: 30, guardHash: 123 }),
    });
    const state = initialCodexScanState();
    for (const line of [
      { type: "session_meta", payload: { id: "session-c", model_provider: "openai" } },
      { type: "turn_context", payload: { model: "gpt-6-astra", turn_id: "native-turn" } },
      {
        type: "event_msg",
        timestamp: "2026-08-01T10:00:00Z",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 1, output_tokens: 2 } },
        },
      },
    ])
      parseCodexLine(JSON.stringify(line), state);
    const pending = {
      ...record({
        provider: "codex",
        model: "gpt-6-astra",
        sessionId: "session-c",
        dedupeKey: null,
      }),
      unresolvedServiceTierTurnId: "native-turn",
    };
    const pendingTail = { ...pending, unresolvedServiceTierTurnId: "native-tail" };
    original.set("/codex.jsonl", {
      size: 80,
      malformedRecords: 3,
      mtimeMs: 400,
      provider: "codex",
      records: [
        record({
          provider: "codex",
          model: "gpt-6-astra",
          rateModel: "gpt-6",
          dedupeKey: null,
          speed: "ultrafast",
        }),
        pending,
      ],
      tailRecords: [pendingTail],
      tailMalformedRecords: 1,
      position: position({ state }),
    });

    original.set("/a.jsonl", {
      ...original.get("/a.jsonl")!,
      tailRecords: [record({ dedupeKey: "msg_tail:" })],
    });
    const claude = original.get("/a.jsonl")!;
    const cached = new Map(original);
    cached.set("/a.jsonl", {
      ...claude,
      records: [...claude.records, record({ model: "<synthetic>" })],
      tailRecords: [
        ...claude.tailRecords,
        record({ model: "<synthetic>", dedupeKey: "msg_tail:" }),
      ],
    });
    const restored = decodeScanCache(
      JSON.parse(JSON.stringify(encodeScanCache(cached))),
      TEST_FORMAT_MAP,
    );

    expect(restored.size).toBe(4);
    expect(restored).toEqual(original);
  });

  it.each([6, 7, 8])(
    "migrates upstream v%s by shape, keeping history and diagnostics but re-parsing",
    (version) => {
      // Upstream v6–v8 share the fork's file names and versions. Its entries
      // carry a whole-file `mr` instead of `x`/`tx`, and its v7/v8 rows put the
      // tier turn at index 12, where the fork marks provisional records.
      const pending = record({
        provider: "codex",
        model: "gpt-6-astra",
        dedupeKey: null,
        ...(version >= 7 ? { unresolvedServiceTierTurnId: "native-turn" } : {}),
      });
      const original = cacheWith([["/gone.jsonl", 100, [record({ speed: "fast" })]]]);
      original.set("/gone-codex.jsonl", {
        ...original.get("/gone.jsonl")!,
        provider: "codex",
        records: [pending],
        malformedRecords: 2,
        position: position({ state: codexState() }),
      });
      original.set("/gone-pi.jsonl", {
        ...original.get("/gone.jsonl")!,
        provider: "pi",
        records: [record({ provider: "pi", model: "anthropic/claude-fable-5" })],
        malformedRecords: 3,
        position: position({ state: { sessionId: "session-a" } }),
      });
      const encoded = encodeScanCache(original);
      const upstream = {
        ...encoded,
        version,
        files: Object.fromEntries(
          Object.entries(encoded.files).map(([path, { x, tx: _tx, ...file }]) => {
            const upstreamRow = (row: readonly unknown[]) =>
              typeof row[14] === "string" ? [...row.slice(0, 12), row[14]] : row.slice(0, 12);
            return [
              path,
              { ...file, mr: x, r: file.r.map(upstreamRow), t: file.t.map(upstreamRow) },
            ];
          }),
        ),
      };
      if (version >= 7) {
        expect(upstream.files["/gone-codex.jsonl"]!.r[0]![12]).toBe("native-turn");
      }

      const restored = decodeScanCache(JSON.parse(JSON.stringify(upstream)), TEST_FORMAT_MAP);

      expect(restored).toEqual(
        new Map(
          [...original].map(([path, file]) => [
            path,
            { ...file, requiresReparse: true, position: MIGRATED_POSITION },
          ]),
        ),
      );
    },
  );

  it("rewrites only changed entries and still restores the whole cache", () => {
    const write = makeScanCacheWriter();
    const cache = cacheWith([
      ["/a.jsonl", 100, [record()]],
      ["/b.jsonl", 200, [record({ sessionId: "session-b" })]],
    ]);
    cache.set("/b.jsonl", { ...cache.get("/b.jsonl")!, malformedRecords: 2 });
    const sources = { "claude\u0000/projects": { dir: "/projects", volumeId: "1:2" } };
    expect(decodeScanCache(JSON.parse(write(cache, { sources })), TEST_FORMAT_MAP)).toEqual(cache);

    cache.set("/b.jsonl", {
      ...cache.get("/b.jsonl")!,
      size: 30,
      malformedRecords: 4,
      records: [record({ sessionId: "session-c", model: "claude-opus-5-5", dedupeKey: "msg_3:" })],
    });
    const document = JSON.parse(write(cache, { sources }));
    expect(decodeScanCache(document, TEST_FORMAT_MAP)).toEqual(cache);
    expect(document.sources).toEqual(sources);
  });

  it("treats a corrupt or foreign document as an empty cache", () => {
    expect(decodeScanCache(null, TEST_FORMAT_MAP).size).toBe(0);
    expect(decodeScanCache("nonsense", TEST_FORMAT_MAP).size).toBe(0);
    expect(
      decodeScanCache({ version: 999, models: [], sessions: [], files: {} }, TEST_FORMAT_MAP).size,
    ).toBe(0);
  });

  it("skips malformed file entries but keeps good ones", () => {
    const encoded = encodeScanCache(cacheWith([["/good.jsonl", 100, [record()]]]));
    const withJunk = {
      ...encoded,
      files: { ...encoded.files, "/bad.jsonl": { s: "nope", m: 1, p: "claude", r: [] } },
    };

    const restored = decodeScanCache(JSON.parse(JSON.stringify(withJunk)), TEST_FORMAT_MAP);
    expect([...restored.keys()]).toEqual(["/good.jsonl"]);
  });

  it("drops the whole entry when any row is corrupt, forcing a cold re-parse", () => {
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

    const restored = decodeScanCache(JSON.parse(JSON.stringify(poisoned)), TEST_FORMAT_MAP);
    expect(restored.has("/a.jsonl")).toBe(false);
  });

  it("carries completed and tail malformed counts across a round trip", () => {
    // The tail is re-read on resume, so its count must stay separate from
    // completed lines rather than being accumulated again on every scan.
    const original = cacheWith([["/a.jsonl", 100, [record()], 3, 2]]);

    const restored = decodeScanCache(
      JSON.parse(JSON.stringify(encodeScanCache(original))),
      TEST_FORMAT_MAP,
    );

    expect(restored.get("/a.jsonl")?.malformedRecords).toBe(3);
    expect(restored.get("/a.jsonl")?.tailMalformedRecords).toBe(2);
  });

  it("rejects a cache written before entries carried a malformed count", () => {
    // A v1 entry cannot say how many of its lines failed to parse, and
    // reporting those files as clean is worse than one cold re-parse.
    const encoded = encodeScanCache(cacheWith([["/a.jsonl", 100, [record()], 2]]));
    const previousVersion = { ...encoded, version: 1 };

    expect(decodeScanCache(JSON.parse(JSON.stringify(previousVersion)), TEST_FORMAT_MAP).size).toBe(
      0,
    );
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

    const restored = decodeScanCache(JSON.parse(JSON.stringify(withBadCounts)), TEST_FORMAT_MAP);
    expect([...restored.keys()]).toEqual(["/good.jsonl"]);
  });
});

describe("dedupeWithinFile", () => {
  it("keeps a Claude message's completed record, at its first position", () => {
    // Native records repeat the input split, but only the last has full output.
    const kept = dedupeWithinFile([
      record({ totals: { ...record().totals, outputTokens: 6 } }),
      record({ dedupeKey: "msg_2:" }),
      record({ totals: { ...record().totals, outputTokens: 999 }, speed: "fast" }),
      record({ totals: { ...record().totals, outputTokens: 6 } }),
    ]);

    expect(kept.map((r) => [r.dedupeKey, r.totals.outputTokens, r.speed])).toEqual([
      ["msg_1:", 999, "fast"],
      ["msg_2:", 50, "standard"],
    ]);
  });

  it("keeps the first record per dedupe key for other providers", () => {
    const grok = (outputTokens: number) =>
      record({ provider: "grok", totals: { ...record().totals, outputTokens } });

    expect(dedupeWithinFile([grok(1), grok(999)]).map((r) => r.totals.outputTokens)).toEqual([1]);
  });

  it("replaces a provisional record with real usage, at its position", () => {
    const placeholder = record({
      totals: { ...record().totals, uncachedInputTokens: 0, outputTokens: 0 },
      provisional: true,
    });
    const final = record({ totals: { ...record().totals, outputTokens: 312 } });
    const other = record({ dedupeKey: "msg_2:" });

    expect(dedupeWithinFile([placeholder, placeholder, other, final])).toEqual([final, other]);
    // A later placeholder never replaces real usage.
    expect(dedupeWithinFile([final, placeholder])).toEqual([final]);
    // Without real usage, the first placeholder stays.
    expect(dedupeWithinFile([placeholder, other])).toEqual([placeholder, other]);
  });
});
