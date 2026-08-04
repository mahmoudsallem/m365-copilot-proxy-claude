import { describe, expect, it } from "vitest";
import { makeOrientationToolCall } from "./handler.js";

const bashTool = {
  type: "function" as const,
  function: {
    name: "bash",
    description: "Run a shell command",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
};

const claudeCodeBashTool = {
  type: "function" as const,
  function: {
    name: "Bash",
    description: "Run a shell command",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
};

const readFileTool = {
  type: "function" as const,
  function: {
    name: "read_file",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
};

describe("first-turn confabulation recovery", () => {
  it("returns one safe, read-only orientation call for a compatible bash tool", () => {
    const call = makeOrientationToolCall({
      model: "gpt-5.5-think-deeper",
      messages: [{ role: "user", content: "list all files here" }],
      stream: false,
      tools: [bashTool],
    });

    expect(call?.function.name).toBe("bash");
    expect(JSON.parse(call!.function.arguments)).toEqual({ command: "pwd && ls -la" });
  });

  it("uses Claude Code's uppercase Bash tool instead of looking for lowercase bash", () => {
    const call = makeOrientationToolCall({
      model: "claude-sonnet",
      messages: [{ role: "user", content: "list all files here" }],
      stream: false,
      tools: [claudeCodeBashTool],
    });

    expect(call?.function.name).toBe("Bash");
    expect(JSON.parse(call!.function.arguments)).toEqual({ command: "pwd && ls -la" });
  });

  it("does not override a specifically selected non-bash tool", () => {
    const call = makeOrientationToolCall({
      model: "gpt-5.5-think-deeper",
      messages: [{ role: "user", content: "read a file" }],
      stream: false,
      tools: [bashTool, readFileTool],
      tool_choice: { type: "function", function: { name: "read_file" } },
    });

    expect(call).toBeNull();
  });
});
