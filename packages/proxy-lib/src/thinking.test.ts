import { describe, it, expect } from "vitest";
import type { CopilotStream } from "@m365-copilot/core";
import { createApp } from "./index.js";

// F17.10: M365's ChainOfThought transcript (contentOrigin=ChainOfThoughtSummary /
// addToChainOfThought=true) must surface as REAL Anthropic thinking blocks and
// OpenAI reasoning_content — genuine thinking parity with native Claude Code.

function streamWithThinking(text: string, thinking: string): CopilotStream {
  return {
    fullText: text,
    thinkingText: thinking,
    hasThinking: true,
    hasContent: true,
    images: [],
    throttle: { current: 1, max: 600 },
    contentOrigin: "Fake",
    messageType: null,
    messageId: "m",
    scores: {},
    turnCount: 1,
    turnState: "Completed",
    async *[Symbol.asyncIterator]() { yield text; },
  };
}

const BASH = {
  name: "bash", description: "Run shell",
  input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
};

describe("ChainOfThought → thinking blocks (F17.10)", () => {
  it("anthropic non-stream emits a thinking block before text", async () => {
    const transport = {
      prompts: [],
      reset() {},
      chat: async () => streamWithThinking("The ball costs $0.05.", "Let x = ball. Then x + (x+1) = 1.10, so x = 0.05."),
    } as any;
    const app = createApp({ getToken: async () => "t", useAgent: false, transport });
    const res = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 64, messages: [{ role: "user", content: "riddle" }] }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content[0].type).toBe("thinking");
    expect(body.content[0].thinking).toContain("x = ball");
    expect(body.content[0].signature).toBe("");
    expect(body.content[1].text).toContain("$0.05");
  });

  it("anthropic SSE: thinking block sequence (start/thinking_delta/signature_delta/stop)", async () => {
    const transport = {
      prompts: [], reset() {},
      chat: async () => streamWithThinking("Answer.", "Step one. Step two."),
    } as any;
    const app = createApp({ getToken: async () => "t", useAgent: false, transport });
    const res = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", max_tokens: 32, stream: true, messages: [{ role: "user", content: "q" }] }),
    }));
    const raw = await res.text();
    const events = raw.split("\n\n").filter((b) => b.startsWith("event: "))
      .map((b) => ({ ev: b.split("\n")[0].slice(7), data: JSON.parse(b.split("\n")[1].slice(6)) }));
    const thinkStart = events.find((e) => e.ev === "content_block_start" && e.data.content_block.type === "thinking");
    expect(thinkStart).toBeDefined();
    expect(thinkStart!.data.content_block.signature).toBe("");
    const td = events.filter((e) => e.data?.delta?.type === "thinking_delta");
    expect(td.map((e) => e.data.delta.thinking).join("")).toContain("Step one");
    const sig = events.find((e) => e.data?.delta?.type === "signature_delta");
    expect(sig).toBeDefined();
    // Both blocks exist with distinct indexes (streaming emits text first as it
    // arrives; thinking is appended once the turn completes).
    const textStart = events.find((e) => e.ev === "content_block_start" && e.data.content_block.type === "text");
    expect(textStart).toBeDefined();
    expect(thinkStart!.data.index).not.toBe(textStart!.data.index);
  });

  it("openai non-stream exposes reasoning_content", async () => {
    const transport = {
      prompts: [], reset() {},
      chat: async () => streamWithThinking("Hi.", "reasoning trace"),
    } as any;
    const app = createApp({ getToken: async () => "t", useAgent: false, transport });
    const res = await app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", max_tokens: 32, messages: [{ role: "user", content: "x" }] }),
    }));
    const body = await res.json();
    expect(body.choices[0].message.reasoning_content).toBe("reasoning trace");
  });

  it("tools path carries thinking alongside tool_calls (anthropic)", async () => {
    const transport = {
      prompts: [], reset() {},
      chat: async () => streamWithThinking("```bash\necho hi\n```", "need to run echo"),
    } as any;
    const app = createApp({ getToken: async () => "t", useAgent: false, transport });
    const res = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 64, tools: [BASH], messages: [{ role: "user", content: "run" }] }),
    }));
    const body = await res.json();
    expect(body.stop_reason).toBe("tool_use");
    expect(body.content[0].type).toBe("thinking");
    expect(body.content[0].thinking).toContain("echo");
    expect(body.content[1].type).toBe("tool_use");
  });
});
