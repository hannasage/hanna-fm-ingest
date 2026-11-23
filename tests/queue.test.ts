import { describe, expect, it } from "vitest";
import { RateLimitedQueue } from "../src/musicbrainz.ts";

/** A queue on a fake clock, so the test needs no real waiting. */
function fakeQueue(interval = 1000) {
  const clock = { now: 0 };
  const queue = new RateLimitedQueue(
    interval,
    async (ms) => {
      clock.now += ms;
    },
    () => clock.now,
  );
  return { queue, clock };
}

describe("RateLimitedQueue", () => {
  it("starts each task at least the interval after the previous one ended, even when all are asked at once", async () => {
    const { queue, clock } = fakeQueue();
    const starts: number[] = [];
    const ends: number[] = [];
    await Promise.all(
      Array.from({ length: 5 }, () =>
        queue.run(async () => {
          starts.push(clock.now);
          clock.now += 50;
          ends.push(clock.now);
        }),
      ),
    );
    expect(starts).toHaveLength(5);
    for (let index = 1; index < starts.length; index += 1) {
      expect(starts[index]! - ends[index - 1]!).toBeGreaterThanOrEqual(1000);
    }
    expect(queue.requests).toBe(5);
  });

  it("runs the tasks in the order they were asked", async () => {
    const { queue } = fakeQueue();
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((n) => queue.run(async () => void order.push(n))));
    expect(order).toEqual([1, 2, 3]);
  });

  it("keeps going after a task fails, and still counts the failed request", async () => {
    const { queue } = fakeQueue();
    await expect(queue.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(queue.run(async () => "next")).resolves.toBe("next");
    expect(queue.requests).toBe(2);
  });

  it("holds the next task for a longer wait, and never for a shorter one", async () => {
    const { queue, clock } = fakeQueue();
    await queue.run(async () => undefined);
    queue.holdFor(5000);
    queue.holdFor(10);
    const before = clock.now;
    await queue.run(async () => undefined);
    expect(clock.now - before).toBeGreaterThanOrEqual(5000);
  });

  it("checks the clock again after a sleep that ends early", async () => {
    const clock = { now: 0 };
    const queue = new RateLimitedQueue(
      1000,
      async (ms) => {
        clock.now += ms / 2;
      },
      () => clock.now,
    );
    await queue.run(async () => undefined);
    const before = clock.now;
    await queue.run(async () => undefined);
    expect(clock.now - before).toBeGreaterThanOrEqual(1000 - 1);
  });
});
