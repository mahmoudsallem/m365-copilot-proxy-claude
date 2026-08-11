import { describe, expect, it } from "vitest";
import {
  enforceSingleToolCall,
  formatDeltaMessages,
  makeOrientationToolCall,
} from "./handler.js";

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

  it("uses an allowlisted directory-listing tool when no shell tool exists", () => {
    const call = makeOrientationToolCall({
      model: "claude-sonnet",
      messages: [{ role: "user", content: "list all files here" }],
      stream: false,
      tools: [{
        type: "function",
        function: {
          name: "list_directory",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      }],
    });

    expect(call?.function.name).toBe("list_directory");
    expect(JSON.parse(call!.function.arguments)).toEqual({ path: "." });
  });

  it("never invokes an arbitrary first tool as an orientation fallback", () => {
    const call = makeOrientationToolCall({
      model: "claude-sonnet",
      messages: [{ role: "user", content: "inspect the workspace" }],
      stream: false,
      tools: [readFileTool],
    });

    expect(call).toBeNull();
  });
});

describe("tool metadata and one-call feedback", () => {
  it("preserves tool name, id, and command metadata on delta turns", () => {
    const text = formatDeltaMessages([
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "toolu_1",
          type: "function",
          function: { name: "Bash", arguments: '{"command":"ls -la"}' },
        }],
      },
      { role: "tool", tool_call_id: "toolu_1", content: "README.md" },
    ], "Only the first prior tool call ran.");

    expect(text).toContain("<runtime_notice>");
    expect(text).toContain('tool="Bash"');
    expect(text).toContain('call_id="toolu_1"');
    expect(text).toContain('command="ls -la"');
    expect(text).toContain("README.md");
  });

  it("keeps one call and tells the next turn exactly what was not executed", () => {
    const calls = [
      { function: { name: "Read" } },
      { function: { name: "Edit" } },
      { function: { name: "Bash" } },
    ];
    const result = enforceSingleToolCall(calls);
    expect(result.calls).toEqual([calls[0]]);
    expect(result.runtimeNotice).toContain("executed only the first (Read)");
    expect(result.runtimeNotice).toContain("did not execute Edit, Bash");
  });
});
