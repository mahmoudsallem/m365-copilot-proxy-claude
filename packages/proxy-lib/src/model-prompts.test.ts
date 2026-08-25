import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { modelPromptCandidates, resolveModelSystemPrompt, modelPromptEnabled } from "./model-prompts.js";

// The corpus (vendor/system-prompts-leaks) is cloned into this checkout, so
// resolution tests run against real files. When it's absent they degrade to
// routing-table-only assertions.
const corpusAvailable = ["vendor/system-prompts-leaks", "../../../vendor/system-prompts-leaks"]
  .some((rel) => fs.existsSync(path.resolve(process.cwd(), rel)));

describe("modelPromptCandidates (route table)", () => {
  it("routes Claude models to Anthropic prompts", () => {
    expect(modelPromptCandidates("claude-opus")[0]).toMatch(/^Anthropic\/claude-opus/);
    expect(modelPromptCandidates("claude-sonnet-think-deeper")[0]).toMatch(/^Anthropic\//);
  });

  it("routes claude-code requests to the Claude Code prompts", () => {
    expect(modelPromptCandidates("claude-code")[0]).toContain("claude-code");
    expect(modelPromptCandidates("claude-code-sonnet-5")[0]).toContain("claude-code");
  });

  it("routes GPT/Codex models to OpenAI prompts", () => {
    expect(modelPromptCandidates("gpt-5.5-think-deeper")[0]).toBe("OpenAI/gpt-5.5-thinking");
    expect(modelPromptCandidates("gpt-5.6-sol")[0]).toBe("OpenAI/gpt-5.6-sol");
    expect(modelPromptCandidates("codex")[0]).toContain("Codex");
    expect(modelPromptCandidates("o3-high")[0]).toContain("API/");
  });

  it("routes Gemini/Grok/Copilot families", () => {
    expect(modelPromptCandidates("gemini-3-pro")[0]).toBe("Google/gemini-3.1-pro");
    expect(modelPromptCandidates("grok-4")[0]).toMatch(/^xAI\//);
    expect(modelPromptCandidates("m365-copilot").join(" ")).toContain("Microsoft/");
    expect(modelPromptCandidates("cursor-latest")[0]).toBe("Cursor/cursor");
  });

  it("routes EVERY advertised alias, including bare family names and Copilot flavors", () => {
    for (const alias of [
      "haiku", "claude-haiku-4.5", "opus", "opus-4", "opus-5", "sonnet", "sonnet-4",
      "sol", "terra", "luna", "gpt-5.6", "auto", "quick", "think-deeper",
      "claude-opus-4-20250514", "claude-3-5-haiku-20241022",
    ]) {
      const candidates = modelPromptCandidates(alias);
      expect(candidates.length, `alias "${alias}" should route`).toBeGreaterThan(0);
    }
    expect(modelPromptCandidates("haiku")[0]).toMatch(/^Anthropic\//);
    expect(modelPromptCandidates("terra")[0]).toBe("OpenAI/gpt-5.6-sol");
    expect(modelPromptCandidates("auto").join(" ")).toContain("Microsoft/");
  });

  it("unknown models are unrouted", () => {
    expect(modelPromptCandidates("totally-made-up")).toEqual([]);
    expect(modelPromptCandidates(undefined)).toEqual([]);
  });
});

describe("resolveModelSystemPrompt", () => {
  it("is disabled unless M365_MODEL_PROMPTS=1", () => {
    delete process.env.M365_MODEL_PROMPTS;
    expect(modelPromptEnabled()).toBe(false);
    process.env.M365_MODEL_PROMPTS = "1";
    try {
      expect(modelPromptEnabled()).toBe(true);
    } finally {
      delete process.env.M365_MODEL_PROMPTS;
    }
  });

  it.skipIf(!corpusAvailable)("resolves routed text from the corpus when enabled", () => {
    process.env.M365_MODEL_PROMPTS = "1";
    delete process.env.M365_MODEL_PROMPT_MAX_CHARS;
    try {
      const hit = resolveModelSystemPrompt("claude-opus");
      expect(hit).not.toBeNull();
      expect(hit!.name).toMatch(/^Anthropic\//);
      // Default cap (12k chars) applies — corpus prompts run far larger.
      expect(hit!.text.length).toBeLessThanOrEqual(12_100);
      expect(hit!.text.length).toBeGreaterThan(200);
    } finally {
      delete process.env.M365_MODEL_PROMPTS;
    }
  });

  it.skipIf(!corpusAvailable)("returns null when disabled even for routed models", () => {
    delete process.env.M365_MODEL_PROMPTS;
    expect(resolveModelSystemPrompt("claude-opus")).toBeNull();
  });

  it.skipIf(!corpusAvailable)("caps length via M365_MODEL_PROMPT_MAX_CHARS", () => {
    process.env.M365_MODEL_PROMPTS = "1";
    process.env.M365_MODEL_PROMPT_MAX_CHARS = "500";
    try {
      const hit = resolveModelSystemPrompt("claude-opus");
      expect(hit).not.toBeNull();
      expect(hit!.truncated).toBe(true);
      expect(hit!.text.length).toBeLessThanOrEqual(600);
      expect(hit!.text).toContain("[system prompt truncated");
    } finally {
      delete process.env.M365_MODEL_PROMPTS;
      delete process.env.M365_MODEL_PROMPT_MAX_CHARS;
    }
  });
});
