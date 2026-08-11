import { describe, expect, it } from "vitest";
import {
  CONSERVATIVE_MODEL_LIMITS,
  getAvailableModelCapabilities,
  getAvailableModels,
  getDefaultModel,
  getModelCapability,
  getToneForModel,
  resolveModelCapability,
} from "./models.js";

describe("truthful model capability registry", () => {
  it("is the single catalog for all 21 public ids", () => {
    const ids = getAvailableModels();
    const capabilities = getAvailableModelCapabilities();
    expect(ids).toHaveLength(21);
    expect(new Set(ids).size).toBe(21);
    expect(capabilities.map((entry) => entry.id)).toEqual(ids);
  });

  it("keeps observed limits conservative on every route", () => {
    expect(CONSERVATIVE_MODEL_LIMITS).toMatchObject({
      maxInputTokens: 128_000,
      maxOutputTokens: 3_072,
      basis: "conservative-observed",
    });
    for (const capability of getAvailableModelCapabilities()) {
      expect(capability.limits).toBe(CONSERVATIVE_MODEL_LIMITS);
      expect(capability.lastTestedServiceVersion).toContain("2026-07-07");
    }
  });

  it("marks Opus broken and never auto-selectable", () => {
    expect(getModelCapability("claude-opus")).toMatchObject({
      tone: "Claude_Opus",
      certification: "broken",
      toolReliability: "broken",
      autoSelectable: false,
      evaluation: { solved: 0, attempted: 3 },
    });
  });

  it("does not falsely certify routes before the expanded gates", () => {
    expect(getModelCapability("m365-copilot")?.certification).toBe("experimental");
    expect(getModelCapability("claude-sonnet")?.certification).toBe("experimental");
    expect(getModelCapability("gpt-5.5-think-deeper")?.certification).toBe("experimental");
    expect(getDefaultModel()).toBe("gpt-5.5-think-deeper");
  });

  it("routes unknown Claude client labels to Sonnet, never implicitly to Opus", () => {
    expect(getToneForModel("claude-opus-5[1m]")).toBe("Claude_Sonnet");
    expect(resolveModelCapability("claude-opus-5[1m]").id).toBe("claude-sonnet");
    expect(getToneForModel("unknown-model")).toBe("magic");
  });
});
