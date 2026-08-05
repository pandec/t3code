import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { SerializedAsyncQueue } from "./serialized-async-queue";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("SerializedAsyncQueue", () => {
  it("does not let a newer operation overtake an in-flight operation", async () => {
    const queue = new SerializedAsyncQueue();
    const firstGate = deferred();
    const events: string[] = [];

    const first = queue.run(async () => {
      events.push("first:start");
      await firstGate.promise;
      events.push("first:end");
    });
    const second = queue.run(async () => {
      events.push("second");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    firstGate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });

  it("continues after a rejected operation", async () => {
    const queue = new SerializedAsyncQueue();
    const first = queue.run(async () => {
      throw new Error("failed");
    });
    const second = queue.run(async () => "recovered");

    await expect(first).rejects.toThrow("failed");
    await expect(second).resolves.toBe("recovered");
  });

  it("drains every operation queued before shutdown", async () => {
    const queue = new SerializedAsyncQueue();
    const gate = deferred();
    let complete = false;
    void queue.run(async () => {
      await gate.promise;
      complete = true;
    });

    const drained = queue.drain();
    expect(complete).toBe(false);
    gate.resolve();
    await drained;
    expect(complete).toBe(true);
  });

  it("keeps draining until the queue tail stabilizes", async () => {
    const queue = new SerializedAsyncQueue();
    const firstGate = deferred();
    const secondGate = deferred();
    let drained = false;

    void queue.run(() => firstGate.promise);
    const drain = queue.drain().then(() => {
      drained = true;
    });
    void queue.run(() => secondGate.promise);

    firstGate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(drained).toBe(false);

    secondGate.resolve();
    await drain;
    expect(drained).toBe(true);
  });

  it("lets initial work finish before delayed maintenance gates later work", async () => {
    vi.useFakeTimers();
    try {
      const queue = new SerializedAsyncQueue();
      const maintenanceGate = deferred();
      const events: string[] = [];
      const maintenance = queue.schedule(1_000, async () => {
        events.push("maintenance:start");
        await maintenanceGate.promise;
        events.push("maintenance:end");
      });

      await queue.run(async () => {
        events.push("initial-read");
      });
      expect(events).toEqual(["initial-read"]);

      await vi.advanceTimersByTimeAsync(1_000);
      const laterRead = queue.run(async () => {
        events.push("later-read");
      });
      await Promise.resolve();
      expect(events).toEqual(["initial-read", "maintenance:start"]);

      maintenanceGate.resolve();
      await Promise.all([maintenance.done, laterRead]);
      expect(events).toEqual([
        "initial-read",
        "maintenance:start",
        "maintenance:end",
        "later-read",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels maintenance that has not started", async () => {
    const queue = new SerializedAsyncQueue();
    let ran = false;
    const scheduled = queue.schedule(60_000, async () => {
      ran = true;
    });

    scheduled.cancel();
    await scheduled.done;
    expect(ran).toBe(false);
  });
});
