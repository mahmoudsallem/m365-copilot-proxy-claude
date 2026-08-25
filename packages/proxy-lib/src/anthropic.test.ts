import { describe, expect, it } from "vitest";
import {
  AnthropicMessagesRequest,
  anthropicSse,
  estimateAnthropicInputTokens,
  fromOpenAIChatResponse,
  resolveM365Model,
  toOpenAIChatRequest,
} from "./anthropic.js";

describe("Anthropic Messages compatibility", () => {
  it("translates Claude tool definitions and tool results to OpenAI chat", () => {
    const body = AnthropicMessagesRequest.parse({
      model: "claude-sonnet-4.5",
      max_tokens: 4096,
      system: [{ type: "text", text: "You are a coding agent.", cache_control: { type: "ephemeral" } }],
      tools: [{ name: "Bash", description: "Run a command", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
      messages: [
        { role: "user", content: "List files" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "README.md" }] },
      ],
      stream: true,
    });

    const translated = toOpenAIChatRequest(body);
    expect(translated.stream).toBe(false);
    expect(translated.model).toBe("claude-sonnet");
    expect(translated.tools?.[0].function.name).toBe("Bash");
    expect(translated.messages).toEqual([
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "List files" },
      { role: "assistant", content: null, tool_calls: [{ id: "toolu_1", type: "function", function: { name: "Bash", arguments: "{\"command\":\"ls\"}" } }] },
      { role: "tool", tool_call_id: "toolu_1", content: "README.md" },
    ]);
  });

  it("translates OpenAI tool calls and emits Anthropic SSE events", async () => {
    const message = fromOpenAIChatResponse({
      id: "chatcmpl-1",
      model: "claude-sonnet-4.5",
      choices: [{
        finish_reason: "tool_calls",
        message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", function: { name: "Bash", arguments: "{\"command\":\"pwd\"}" } }] },
      }],
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    }, "claude-sonnet-4.5");

    expect(message.stop_reason).toBe("tool_use");
    expect(message.content[0]).toEqual({ type: "tool_use", id: "call_1", name: "Bash", input: { command: "pwd" } });
    const stream = await anthropicSse(message).text();
    expect(stream).toContain("event: message_start");
    expect(stream).toContain('"type":"input_json_delta"');
    expect(stream).toContain("event: message_stop");
  });

  it("returns a stable positive token estimate", () => {
    expect(estimateAnthropicInputTokens({ messages: [{ content: "hello" }] })).toBeGreaterThan(0);
  });

  it("maps Claude picker models to canonical M365 models", () => {
    expect(resolveM365Model("claude-opus-5")).toBe("claude-opus");
    expect(resolveM365Model("opus[1m]")).toBe("claude-opus");
    expect(resolveM365Model("gpt-5.5-think-deeper")).toBe("gpt-5.5-think-deeper");
  });
});

describe("image blocks and parallel-tool-use signal", () => {
  it("never drops pasted images — emits an explicit placeholder the model can see", () => {
    const body = AnthropicMessagesRequest.parse({
      model: "claude-sonnet",
      max_tokens: 100,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8" } },
        ],
      }],
    });
    const messages = toOpenAIChatRequest(body).messages;
    const user = messages.find((m) => m.role === "user")!;
    expect(String(user.content)).toContain("[IMAGE ATTACHED: image/png");
    expect(String(user.content)).toContain("vision is not supported");
  });

  it("flags image blocks inside tool_result content arrays too", () => {
    const body = AnthropicMessagesRequest.parse({
      model: "claude-sonnet",
      max_tokens: 100,
      messages: [
        { role: "user", content: "screenshot it" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "shot", input: {} }] },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "t1",
            content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "aGk" } }],
          }],
        },
      ],
    });
    const messages = toOpenAIChatRequest(body).messages;
    const toolMsg = messages.find((m) => m.role === "tool")!;
    expect(String(toolMsg.content)).toContain("[IMAGE ATTACHED: image/jpeg");
  });

  it("requestsSingleToolUse reflects tool_choice.disable_parallel_tool_use", async () => {
    const { requestsSingleToolUse } = await import("./anthropic.js");
    const base = { model: "claude-sonnet", max_tokens: 10, tools: [{ name: "Bash", input_schema: {} }] };
    expect(requestsSingleToolUse(AnthropicMessagesRequest.parse({
      ...base,
      messages: [{ role: "user", content: "x" }],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    }))).toBe(true);
    expect(requestsSingleToolUse(AnthropicMessagesRequest.parse({
      ...base,
      messages: [{ role: "user", content: "x" }],
      tool_choice: { type: "auto" },
    }))).toBe(false);
    expect(requestsSingleToolUse(AnthropicMessagesRequest.parse({
      ...base,
      messages: [{ role: "user", content: "x" }],
    }))).toBe(false);
  });
});
