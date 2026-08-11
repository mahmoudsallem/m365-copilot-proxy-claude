import { describe, expect, it } from "vitest";
import { makePlan } from "./test-helpers.js";
import { DEFAULT_BUDGETS, parsePlan, parseReview } from "./schemas.js";

describe("myclaude.plan/v1", () => {
  it("applies conservative execution defaults", () => {
    const plan = makePlan();
    const parsed = parsePlan({ ...plan, execution: {} });
    expect(parsed.execution).toEqual({ profile: "guarded", concurrency: 1, budgets: DEFAULT_BUDGETS });
  });

  it("rejects unknown, self, and cyclic dependencies", () => {
    const base = makePlan();
    expect(() => parsePlan({ ...base, steps: [{ ...base.steps[0], dependencies: ["missing"] }] })).toThrow(/unknown dependency/);
    expect(() => parsePlan({ ...base, steps: [{ ...base.steps[0], dependencies: ["change"] }] })).toThrow(/itself|cycle/);
    expect(() => parsePlan({ ...base, steps: [
      { ...base.steps[0], id: "one", dependencies: ["two"] },
      { ...base.steps[0], id: "two", dependencies: ["one"] },
    ] })).toThrow(/cycle/);
  });

  it("rejects credential-shaped fields anywhere in artifacts", () => {
    expect(() => parsePlan({ ...makePlan(), apiToken: "secret" })).toThrow(/sensitive field/);
    expect(() => parseReview({
      schemaVersion: "myclaude.review/v1",
      taskId: makePlan().taskId,
      reviewer: { provider: "human" },
      verdict: "approve",
      summary: "ok",
      findings: [{ severity: "info", message: "fine", files: [], password: "bad" }],
      createdAt: new Date().toISOString(),
    })).toThrow(/sensitive field/);
    expect(() => parsePlan({ ...makePlan(), objective: "use password=hunter2" })).toThrow(/credential-shaped value/);
  });
});
