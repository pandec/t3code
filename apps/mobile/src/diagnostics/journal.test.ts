import { describe, expect, it, vi } from "@effect/vitest";

import { createMobileDiagnosticJournal } from "./journal";

describe("mobile diagnostic journal", () => {
  it("bounds pending events and reports dropped records", async () => {
    const batches: unknown[][] = [];
    const journal = createMobileDiagnosticJournal({
      enabled: true,
      maxPendingEvents: 2,
      clock: { wallTimeMs: () => 10, monotonicTimeMs: () => 5 },
      write: (events) => {
        batches.push([...events]);
        return Promise.resolve();
      },
    });

    journal.record("first");
    journal.record("second");
    journal.record("third");
    await journal.flush();

    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject([
      { k: "journal", d: { droppedEvents: 1 } },
      { k: "second" },
      { k: "third" },
    ]);
  });

  it("disables itself after repeated persistence failures", async () => {
    const write = vi.fn(() => Promise.reject(new Error("unavailable")));
    let monotonicTimeMs = 0;
    const journal = createMobileDiagnosticJournal({
      enabled: true,
      clock: { wallTimeMs: () => 100, monotonicTimeMs: () => monotonicTimeMs },
      write,
    });

    journal.record("failure");
    for (const _ of [0, 1, 2]) {
      await journal.flush();
      monotonicTimeMs += 5_000;
    }

    expect(write).toHaveBeenCalledTimes(3);
    expect(journal.enabled()).toBe(false);
  });

  it("keeps collecting when several triggers flush during one failure episode", async () => {
    const write = vi.fn(() => Promise.reject(new Error("unavailable")));
    const journal = createMobileDiagnosticJournal({
      enabled: true,
      clock: { wallTimeMs: () => 1_000, monotonicTimeMs: () => 1_000 },
      write,
    });

    // Backgrounding, a memory warning, and the periodic timer can coincide.
    journal.record("failure");
    await journal.flush();
    await journal.flush();
    await journal.flush();

    expect(write).toHaveBeenCalledTimes(3);
    expect(journal.enabled()).toBe(true);
  });

  it("eventually disables itself during one continuous stream of failures", async () => {
    const write = vi.fn(() => Promise.reject(new Error("unavailable")));
    let monotonicTimeMs = 0;
    const journal = createMobileDiagnosticJournal({
      enabled: true,
      clock: { wallTimeMs: () => 100, monotonicTimeMs: () => monotonicTimeMs },
      write,
    });

    journal.record("failure");
    while (journal.enabled()) {
      await journal.flush();
      monotonicTimeMs += 1_000;
    }

    expect(write).toHaveBeenCalledTimes(11);
  });

  it("accounts for events discarded when a failed batch is requeued", async () => {
    const batches: { readonly k: string; readonly d: Readonly<Record<string, unknown>> }[][] = [];
    let failNext = true;
    const journal = createMobileDiagnosticJournal({
      enabled: true,
      maxPendingEvents: 2,
      clock: { wallTimeMs: () => 10, monotonicTimeMs: () => 5 },
      write: (events) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error("unavailable"));
        }
        batches.push(events.map((event) => ({ k: event.k, d: event.d })));
        return Promise.resolve();
      },
    });

    journal.record("first");
    journal.record("second");
    journal.record("third");
    journal.record("fourth");
    journal.record("fifth");
    const failed = journal.flush();
    // The queued flush has not run yet, so these refill the buffer and leave the
    // failed batch too large to requeue whole.
    journal.record("sixth");
    journal.record("seventh");
    await failed;
    await journal.flush();

    expect(batches).toEqual([
      [
        { k: "journal", d: { droppedEvents: 5 } },
        { k: "sixth", d: {} },
        { k: "seventh", d: {} },
      ],
    ]);
  });
});
