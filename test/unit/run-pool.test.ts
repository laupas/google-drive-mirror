/**
 * Unit tests for runPool() — the bounded-concurrency pool used to parallelize
 * file transfers in the sync engine.
 */

import { describe, it, expect } from "vitest";
import { runPool } from "../../src/sync-engine";

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
