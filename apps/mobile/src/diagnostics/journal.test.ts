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
    const journal = createMobileDiagnosticJournal({ enabled: true, write });

    journal.record("failure");
    await journal.flush();
    await journal.flush();
    await journal.flush();

    expect(write).toHaveBeenCalledTimes(3);
    expect(journal.enabled()).toBe(false);
  });
});
