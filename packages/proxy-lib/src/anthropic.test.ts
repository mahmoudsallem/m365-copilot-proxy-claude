import { describe, expect, it } from "vitest";
import {
  AnthropicMessagesRequest,
  anthropicSse,
  estimateAnthropicInputTokens,
  fromOpenAIChatResponse,
  resolveM365Model,
  toClaudeGatewayModelId,
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
    expect(translated.model).toBe("claude-sonnet-4.5");
    expect(translated.tools?.[0].function.name).toBe("Bash");
    expect(translated.messages).toEqual([
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "List files" },
      { role: "assistant", content: null, tool_calls: [{ id: "toolu_1", type: "function", function: { name: "Bash", arguments: "{\"command\":\"ls\"}" } }] },
      { role: "tool", tool_call_id: "toolu_1", name: "Bash", content: "README.md" },
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

  it("defaults to the conservative observed output limit", () => {
    const body = AnthropicMessagesRequest.parse({
      model: "claude-sonnet",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(body.max_tokens).toBe(3_072);
  });

  it("rejects unsupported content blocks instead of silently discarding them", () => {
    const image = AnthropicMessagesRequest.safeParse({
      model: "claude-sonnet",
      messages: [{
        role: "user",
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }],
      }],
    });
    expect(image.success).toBe(false);

    const thinking = AnthropicMessagesRequest.safeParse({
      model: "claude-sonnet",
      messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "hidden" }] }],
    });
    expect(thinking.success).toBe(false);
  });

  it("rejects image content nested inside tool results", () => {
    const parsed = AnthropicMessagesRequest.safeParse({
      model: "claude-sonnet",
      messages: [{
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: [{ type: "image", source: { type: "base64", data: "AA==" } }],
        }],
      }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects supported block types in roles where translating them would drop data", () => {
    expect(AnthropicMessagesRequest.safeParse({
      model: "claude-sonnet",
      messages: [{
        role: "user",
        content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "pwd" } }],
      }],
    }).success).toBe(false);
    expect(AnthropicMessagesRequest.safeParse({
      model: "claude-sonnet",
      messages: [{
        role: "assistant",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "result" }],
      }],
    }).success).toBe(false);
  });

  it("preserves normalized grounding metadata in Anthropic usage", () => {
    const message = fromOpenAIChatResponse({
      id: "chatcmpl-grounded",
      model: "quick",
      choices: [{ finish_reason: "stop", message: { content: "grounded" } }],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        x_m365_source_attributions: [{ url: "https://example.test", title: "Example" }],
      },
    }, "quick");
    expect(message.usage.x_m365_source_attributions).toEqual([
      { url: "https://example.test", title: "Example" },
    ]);
  });

  it("preserves only the safe M365 diagnostics in non-stream and final SSE usage", async () => {
    const message = fromOpenAIChatResponse({
      id: "chatcmpl-telemetry",
      model: "quick",
      choices: [{ finish_reason: "stop", message: { content: "done" } }],
      usage: {
        prompt_tokens: 2,
        completion_tokens: 3,
        x_m365_requested_model: "quick",
        x_m365_resolved_model: "quick",
        x_m365_tone: "Gpt_Quick",
        x_m365_agent_route: "agentless",
        x_m365_certification: "experimental",
        x_m365_upstream_attempts: 2,
        x_m365_recovery_events: ["empty_response_retry"],
        x_m365_conversation_messages: 18,
        x_m365_conversation_max: 600,
        x_m365_conversation_pct: 3,
        x_m365_conversation_remaining: 582,
        x_m365_latency_ms: 99,
        x_m365_output_chars: 4,
        x_m365_output_bytes: 4,
        x_m365_tool_calls: 0,
        x_m365_last_tested_service: "M365 BizChat/Sydney observed 2026-07-07",
        x_m365_classifier_scores: { private: 1 },
        x_m365_content_origin: "https://private.example/source",
        authorization: "Bearer secret",
      },
    }, "quick");

    expect(message.usage).toMatchObject({
      x_m365_requested_model: "quick",
      x_m365_resolved_model: "quick",
      x_m365_tone: "Gpt_Quick",
      x_m365_agent_route: "agentless",
      x_m365_certification: "experimental",
      x_m365_upstream_attempts: 2,
      x_m365_recovery_events: ["empty_response_retry"],
      x_m365_conversation_messages: 18,
      x_m365_conversation_max: 600,
      x_m365_conversation_remaining: 582,
      x_m365_latency_ms: 99,
      x_m365_output_chars: 4,
      x_m365_output_bytes: 4,
      x_m365_tool_calls: 0,
      x_m365_last_tested_service: "M365 BizChat/Sydney observed 2026-07-07",
    });
    expect(message.usage).not.toHaveProperty("x_m365_classifier_scores");
    expect(message.usage).not.toHaveProperty("x_m365_content_origin");
    expect(message.usage).not.toHaveProperty("authorization");

    // anthropicSse is also public; sanitize again in case a caller constructs a
    // message object instead of using fromOpenAIChatResponse.
    (message.usage as any).x_m365_content_origin = "https://private.example/source";
    (message.usage as any).authorization = "Bearer secret";
    const stream = await anthropicSse(message).text();
    const deltaLine = stream.split("\n").find((line, index, all) =>
      all[index - 1] === "event: message_delta" && line.startsWith("data: "));
    expect(deltaLine).toBeTruthy();
    const delta = JSON.parse(deltaLine!.slice(6));
    expect(delta.usage).toMatchObject({
      output_tokens: 3,
      x_m365_requested_model: "quick",
      x_m365_upstream_attempts: 2,
      x_m365_conversation_remaining: 582,
      x_m365_last_tested_service: "M365 BizChat/Sydney observed 2026-07-07",
    });
    expect(JSON.stringify(delta)).not.toContain("private.example");
    expect(JSON.stringify(delta)).not.toContain("Bearer secret");
    expect(stream).not.toContain("private.example");
    expect(stream).not.toContain("Bearer secret");
  });

  it("maps Claude-only picker models to the stable M365 default", () => {
    expect(resolveM365Model("claude-opus-5")).toBe("gpt-5.5-think-deeper");
    expect(resolveM365Model("opus[1m]")).toBe("gpt-5.5-think-deeper");
    expect(resolveM365Model("gpt-5.5-think-deeper")).toBe("gpt-5.5-think-deeper");
  });

  it("round-trips Claude Code gateway aliases to exact M365 model IDs", () => {
    expect(toClaudeGatewayModelId("gpt-5.5-quick")).toBe("claude-m365--gpt-5.5-quick");
    expect(resolveM365Model("claude-m365--gpt-5.5-quick")).toBe("gpt-5.5-quick");
    expect(resolveM365Model("claude-m365--not-a-real-model")).toBe("gpt-5.5-think-deeper");
  });
});
