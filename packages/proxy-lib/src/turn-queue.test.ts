import { describe, it, expect } from "vitest";
import { enqueueTurn, turnQueueStats } from "./turn-queue.js";

/**
 * Strict FIFO turn queue (AGENTS.md rule #1 enforced mechanically): one M365
 * turn at a time account-wide. Offline tests — no auth, no network.
 */

describe("enqueueTurn (strict FIFO serialization)", () => {
  it("starts turns strictly in enqueue order even when the first is slowest", async () => {
    const order: string[] = [];
    const mk = (id: string, ms: number) => async () => {
      order.push(id); // recorded on ENTRY (slot acquired), not completion
      await new Promise((r) => setTimeout(r, ms));
      return id;
    };
    const results = await Promise.all([
      enqueueTurn(mk("a", 60)),
      enqueueTurn(mk("b", 5)),
      enqueueTurn(mk("c", 20)),
    ]);
    expect(order).toEqual(["a", "b", "c"]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(turnQueueStats().waiting).toBe(0);
  });

  it("a rejected turn reaches its own caller but never poisons the chain", async () => {
    const seen: string[] = [];
    await expect(
      enqueueTurn(async () => {
        seen.push("boom");
        throw new Error("upstream exploded");
      }),
    ).rejects.toThrow("upstream exploded");

    const value = await enqueueTurn(async () => {
      seen.push("after");
      return 42;
    });
    expect(value).toBe(42);
    expect(seen).toEqual(["boom", "after"]);
    expect(turnQueueStats().waiting).toBe(0);
  });

  it("M365_NO_TURN_QUEUE=1 bypasses serialization entirely (parallel entry)", async () => {
    process.env.M365_NO_TURN_QUEUE = "1";
    try {
      let inflight = 0;
      let maxInflight = 0;
      const gate = async (ms: number) => {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((r) => setTimeout(r, ms));
        inflight -= 1;
      };
      await Promise.all([
        enqueueTurn(() => gate(30)),
        enqueueTurn(() => gate(5)),
      ]);
      expect(maxInflight).toBe(2);
    } finally {
      delete process.env.M365_NO_TURN_QUEUE;
    }
  });
});
