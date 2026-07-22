/**
 * Unit tests for runPool() — the bounded-concurrency pool used to parallelize
 * file transfers in the sync engine.
 */

import { describe, it, expect } from "vitest";
import { runPool, runBytePool } from "../../src/sync-engine";

/** A deferred promise for controlling worker timing in tests. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("runPool", () => {
  it("processes every item exactly once", async () => {
    // Arrange
    const items = [1, 2, 3, 4, 5, 6, 7];
    const seen: number[] = [];

    // Act
    await runPool(items, 3, async (n) => {
      seen.push(n);
    });

    // Assert
    expect(seen.sort((a, b) => a - b)).toEqual(items);
  });

  it("never exceeds the concurrency limit", async () => {
    // Arrange: workers block until released, so we can observe how many run.
    const gates = Array.from({ length: 6 }, () => deferred());
    let active = 0;
    let maxActive = 0;

    // Act
    const p = runPool([0, 1, 2, 3, 4, 5], 2, async (i) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await gates[i].promise;
      active--;
    });
    // Release gates over a few microtask turns so overlap can build up.
    for (const g of gates) {
      await Promise.resolve();
      g.resolve();
    }
    await p;

    // Assert: at most 2 workers ran at the same time.
    expect(maxActive).toBe(2);
  });

  it("does nothing for an empty list", async () => {
    let called = 0;
    await runPool([], 4, async () => {
      called++;
    });
    expect(called).toBe(0);
  });

  it("propagates a worker rejection (caller handles per-item errors)", async () => {
    // runPool itself does not swallow errors; the engine's worker catches them.
    await expect(
      runPool([1], 1, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
  });
});

describe("runBytePool", () => {
  it("processes every item exactly once", async () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    const seen: number[] = [];
    await runBytePool(
      items,
      3,
      1000,
      () => 1,
      async (n) => {
        seen.push(n);
      }
    );
    expect(seen.sort((a, b) => a - b)).toEqual(items);
  });

  it("does nothing for an empty list", async () => {
    let called = 0;
    await runBytePool(
      [],
      4,
      1000,
      () => 1,
      async () => {
        called++;
      }
    );
    expect(called).toBe(0);
  });

  it("never exceeds the count ceiling", async () => {
    const gates = Array.from({ length: 6 }, () => deferred());
    let active = 0;
    let maxActive = 0;
    // Tiny sizes so the byte budget never binds — only the count ceiling does.
    const p = runBytePool(
      [0, 1, 2, 3, 4, 5],
      2,
      1_000_000,
      () => 1,
      async (i) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await gates[i].promise;
        active--;
      }
    );
    for (const g of gates) {
      await Promise.resolve();
      g.resolve();
    }
    await p;
    expect(maxActive).toBe(2);
  });

  it("never exceeds the byte budget when count would allow more", async () => {
    // Count ceiling is high (10), but each item is 10 bytes and the budget is
    // 25 bytes -> at most 2 can overlap.
    const gates = Array.from({ length: 4 }, () => deferred());
    let inflightBytes = 0;
    let maxInflightBytes = 0;
    const SIZE = 10;
    const p = runBytePool(
      [0, 1, 2, 3],
      10,
      25,
      () => SIZE,
      async (i) => {
        inflightBytes += SIZE;
        maxInflightBytes = Math.max(maxInflightBytes, inflightBytes);
        await gates[i].promise;
        inflightBytes -= SIZE;
      }
    );
    for (const g of gates) {
      await Promise.resolve();
      g.resolve();
    }
    await p;
    // 2 * 10 = 20 <= 25, but 3 * 10 = 30 > 25.
    expect(maxInflightBytes).toBe(20);
  });

  it("admits an oversized single item instead of deadlocking", async () => {
    // A single item larger than the whole budget must still run (alone).
    let ran = false;
    await runBytePool(
      [0],
      4,
      5,
      () => 1000,
      async () => {
        ran = true;
      }
    );
    expect(ran).toBe(true);
  });

  it("runs oversized items serially (one at a time)", async () => {
    // Every item exceeds the budget; each must wait for the previous to finish.
    const gates = Array.from({ length: 3 }, () => deferred());
    let active = 0;
    let maxActive = 0;
    const p = runBytePool(
      [0, 1, 2],
      4,
      10,
      () => 1000,
      async (i) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await gates[i].promise;
        active--;
      }
    );
    for (const g of gates) {
      await Promise.resolve();
      g.resolve();
    }
    await p;
    expect(maxActive).toBe(1);
  });

  it("propagates a worker rejection", async () => {
    await expect(
      runBytePool(
        [1],
        1,
        1000,
        () => 1,
        async () => {
          throw new Error("boom");
        }
      )
    ).rejects.toThrow("boom");
  });
});
