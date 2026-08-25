import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  classifyFailure,
  ToneHealth,
  toneHealth,
  fallbackChain,
  nextHealthyFallback,
  failoverEnabled,
} from "./health.js";

const signal = (over: Partial<Parameters<typeof classifyFailure>[0]> = {}) => ({
  hasContent: false,
  messageType: null,
  throttle: { current: 2, max: 600 },
  turnState: null,
  elapsedMs: 8_000,
  ...over,
});

describe("classifyFailure (F13/F16.3/F22 signature matrix)", () => {
  it("content-bearing turns are none", () => {
    expect(classifyFailure(signal({ hasContent: true }))).toBe("none");
  });

  it("explicit Disengaged frame wins over everything else", () => {
    expect(classifyFailure(signal({ messageType: "Disengaged" }))).toBe("disengaged");
  });

  it("instant empty with null throttle is dead_agent (~0.7s trap)", () => {
    expect(classifyFailure(signal({ throttle: null, elapsedMs: 700 }))).toBe("dead_agent");
    // slow null-throttle empties do NOT qualify (doc says sub-second signature)
    expect(classifyFailure(signal({ throttle: null, elapsedMs: 9_000 }))).not.toBe("dead_agent");
  });

  it("turnState:Failed is the F16.3 tone_outage signature", () => {
    expect(classifyFailure(signal({ turnState: "Failed", elapsedMs: 2_000 }))).toBe("tone_outage");
  });

  it("ReferencesListComplete tail with healthy counter is F13 throttle", () => {
    expect(classifyFailure(signal({ messageType: "ReferencesListComplete", elapsedMs: 3_000 }))).toBe("throttle");
  });

  it("fast ambiguous empty leans tone_outage; slow one stays throttle (backoff owns it)", () => {
    expect(classifyFailure(signal({ elapsedMs: 3_000 }))).toBe("tone_outage");
    expect(classifyFailure(signal({ elapsedMs: 30_000 }))).toBe("throttle");
  });
});

describe("ToneHealth circuit breaker", () => {
  let th: ToneHealth;
  beforeEach(() => { th = new ToneHealth(); });

  it("closed until threshold consecutive failures", () => {
    expect(th.shouldRouteAway("claude-sonnet")).toBe(false);
    th.recordFailure("claude-sonnet");
    th.recordFailure("claude-sonnet");
    expect(th.shouldRouteAway("claude-sonnet")).toBe(false); // 2 < threshold(3)
    th.recordFailure("claude-sonnet");
    expect(th.status("claude-sonnet")).toBe("open");
    expect(th.shouldRouteAway("claude-sonnet")).toBe(true);
  });

  it("success resets the count", () => {
    th.recordFailure("x");
    th.recordFailure("x");
    th.recordSuccess("x");
    th.recordFailure("x");
    expect(th.status("x")).toBe("closed");
  });

  it("half-open window admits exactly one probe", () => {
    th.recordFailure("y"); th.recordFailure("y"); th.recordFailure("y");
    expect(th.status("y")).toBe("open");
    // Force cooldown elapse without sleeping: backdate openedAt.
    const s = (th as unknown as { states: Map<string, { openedAt: number | null }> }).states.get("y")!;
    s.openedAt = Date.now() - 601_000;
    expect(th.status("y")).toBe("half_open");
    expect(th.shouldRouteAway("y")).toBe(false); // probe claimed
    expect(th.shouldRouteAway("y")).toBe(true);  // further traffic still routed away
    th.recordSuccess("y");
    expect(th.status("y")).toBe("closed");
  });

  it("probe failure re-opens", () => {
    th.recordFailure("z"); th.recordFailure("z"); th.recordFailure("z");
    const s = (th as unknown as { states: Map<string, { openedAt: number | null }> }).states.get("z")!;
    s.openedAt = Date.now() - 601_000;
    expect(th.shouldRouteAway("z")).toBe(false);
    th.recordFailure("z");
    expect(th.status("z")).toBe("open");
  });
});

describe("fallback routing", () => {
  afterEach(() => {
    delete process.env.M365_NO_TONE_FAILOVER;
    toneHealth.resetForTests();
  });

  it("chains are cross-family with gpt-5.5 terminal", () => {
    expect(fallbackChain("claude-sonnet")).toEqual(["claude-opus", "gpt-5.5"]);
    expect(fallbackChain("claude-opus")).toEqual(["claude-sonnet", "gpt-5.5"]);
    expect(fallbackChain("gpt-5.5")).toEqual([]);
  });

  it("nextHealthyFallback skips an open fallback and can be disabled", () => {
    toneHealth.resetForTests();
    for (let i = 0; i < 3; i++) toneHealth.recordFailure("claude-opus");
    expect(nextHealthyFallback("claude-sonnet")).toBe("gpt-5.5");

    process.env.M365_NO_TONE_FAILOVER = "1";
    expect(failoverEnabled()).toBe(false);
    expect(nextHealthyFallback("claude-sonnet")).toBe(null);
  });
});
