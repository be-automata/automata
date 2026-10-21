import { describe, expect, it } from "vitest";

import { mapLimit } from "./map-limit";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("mapLimit", () => {
  it("keeps at most `limit` in flight and refills a lane as soon as it frees", async () => {
    const gates = Array.from({ length: 4 }, deferred);
    const started: number[] = [];
    let inFlight = 0;
    let peak = 0;
    const done = mapLimit([0, 1, 2, 3], 2, async (i) => {
      started.push(i);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await gates[i]!.promise;
      inFlight--;
    });

    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    // Item 1 finishing first frees its lane for item 2 while item 0 is still
    // in flight: no lock-step batch.
    gates[1]!.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual([0, 1, 2]);

    gates[0]!.resolve();
    gates[2]!.resolve();
    gates[3]!.resolve();
    await done;
    expect(started).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
  });

  it("does nothing for no items", async () => {
    let calls = 0;
    await mapLimit([], 5, async () => {
      calls++;
    });
    expect(calls).toBe(0);
  });
});
