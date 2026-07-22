/**
 * Unit tests for forEachPool() — the bounded-concurrency pool used by the BFS
 * listing to reduce each folder's children as it completes (no result array
 * retained, unlike mapPool).
 */

import { describe, it, expect } from "vitest";
import { forEachPool } from "../../src/drive-client";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("forEachPool", () => {
  it("runs every item exactly once", async () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    const seen: number[] = [];
    await forEachPool(items, 3, async (n) => {
      seen.push(n);
    });
    expect(seen.sort((a, b) => a - b)).toEqual(items);
  });

  it("never exceeds the concurrency limit", async () => {
    const gates = Array.from({ length: 6 }, () => deferred());
    let active = 0;
    let maxActive = 0;
    const p = forEachPool([0, 1, 2, 3, 4, 5], 2, async (i) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await gates[i].promise;
      active--;
    });
    for (const g of gates) {
      await Promise.resolve();
      g.resolve();
    }
    await p;
    expect(maxActive).toBe(2);
  });

  it("does nothing for an empty list", async () => {
    let called = 0;
    await forEachPool([], 4, async () => {
      called++;
    });
    expect(called).toBe(0);
  });

  it("propagates a worker error", async () => {
    await expect(
      forEachPool([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
      })
    ).rejects.toThrow("boom");
  });
});
