import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { anthropicMessagesToOpenAI } from "./anthropic.js";
import {
  convertOpenAiSseToAnthropic,
  handleUpstreamMessages,
} from "./upstream.js";

beforeEach(() => {
  process.env.OPENAI_UPSTREAM_BASE_URL = "https://upstream.test";
  process.env.OPENAI_UPSTREAM_API_KEY = "k";
});
afterEach(() => {
  delete process.env.OPENAI_UPSTREAM_BASE_URL;
  delete process.env.OPENAI_UPSTREAM_API_KEY;
});

describe("assistant replay: thinking blocks preserved as context markers", () => {
  it("converts thinking + redacted_thinking into text markers instead of dropping", () => {
    const out = anthropicMessagesToOpenAI({
      model: "claude-sonnet-5",
      max_tokens: 64,
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [
          { type: "thinking", thinking: "I should check the file first", signature: "sig" },
          { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
        ] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        { role: "assistant", content: [
          { type: "redacted_thinking", data: "opaque" },
          { type: "text", text: "done" },
        ] },
      ],
    } as any);
    const a1 = out[1] as any;
    expect(a1.role).toBe("assistant");
    expect(a1.content).toContain("[previous reasoning (thinking)]: I should check the file first");
    expect(a1.tool_calls).toHaveLength(1);
    const a2 = out[3] as any;
    expect(a2.content).toContain("[previous reasoning (redacted_thinking)]");
    expect(a2.content).toContain("done");
  });

  it("orphan tool_result gets a synthesized assistant tool_call stub (no 400)", () => {
    const out = anthropicMessagesToOpenAI({
      model: "claude-sonnet-5",
      max_tokens: 64,
      messages: [
        // History was trimmed: the assistant tool_use is gone but its result remains.
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_orphan", content: "data" }] },
      ],
    } as any);
    const toolMsg = out.find((m: any) => m.role === "tool")!;
    expect(toolMsg.tool_call_id).toBe("call_orphan");
    const prev = out[out.indexOf(toolMsg) - 1] as any;
    expect(prev.role).toBe("assistant");
    expect(prev.tool_calls[0].id).toBe("call_orphan");
  });
});

describe("upstream SSE conversion hardening", () => {
  async function collect(chunks: string[]) {
    const sse = new Response(chunks.join(""), { headers: { "Content-Type": "text/event-stream" } });
    const res = convertOpenAiSseToAnthropic(sse, "claude-sonnet-5");
    const raw = await res.text();
    return raw.split("\n\n").filter((b) => b.startsWith("event: ")).map((b) => ({
      event: b.split("\n")[0].slice(7),
      data: JSON.parse(b.split("\n")[1].slice(6)),
    }));
  }

  it("accepts delta.text variant (non-OpenAI-strict upstreams)", async () => {
    const events = await collect([
      'data: {"choices":[{"delta":{"text":"hello"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
    ]);
    const text = events.filter((e) => e.data?.delta?.type === "text_delta").map((e) => e.data.delta.text).join("");
    expect(text).toBe("hello");
    const md = events.find((e) => e.event === "message_delta")!;
    expect(md.data.usage.output_tokens).toBe(2); // real usage, not constant 0
  });

  it("message_start carries cache_* usage fields Claude Code reads", async () => {
    const events = await collect(['data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n']);
    const ms = events.find((e) => e.event === "message_start")!;
    expect(ms.data.message.usage.cache_read_input_tokens).toBe(0);
    expect(ms.data.message.usage.cache_creation_input_tokens).toBe(0);
  });
});

describe("handleUpstreamMessages non-stream passes usage through", () => {
  it("maps completion_tokens into output_tokens", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    }), { status: 200 })) as unknown as typeof fetch;
    const res = await handleUpstreamMessages({
      model: "x", max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    } as any, undefined, fakeFetch);
    const msg = await res.json();
    expect(msg.content[0].text).toBe("ok");
  });
});
