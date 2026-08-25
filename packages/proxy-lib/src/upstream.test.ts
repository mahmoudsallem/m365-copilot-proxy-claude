import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  upstreamEnabled,
  upstreamConfig,
  mapUpstreamModel,
  handleUpstreamChat,
  handleUpstreamMessages,
  convertOpenAiSseToAnthropic,
} from "./upstream.js";

const BASE = "https://upstream.test";

function setEnv() {
  process.env.OPENAI_UPSTREAM_BASE_URL = BASE;
  process.env.OPENAI_UPSTREAM_API_KEY = "sk-test";
  process.env.UPSTREAM_BIG_MODEL = "gpt-big";
  process.env.UPSTREAM_SMALL_MODEL = "gpt-small";
}
function clearEnv() {
  delete process.env.OPENAI_UPSTREAM_BASE_URL;
  delete process.env.OPENAI_UPSTREAM_API_KEY;
  delete process.env.UPSTREAM_BIG_MODEL;
  delete process.env.UPSTREAM_SMALL_MODEL;
}
beforeEach(setEnv);
afterEach(clearEnv);

const sse = (chunks: string) => new Response(chunks, { headers: { "Content-Type": "text/event-stream" } });

async function collectSse(res: Response): Promise<Array<{ event: string; data: any }>> {
  const raw = await res.text();
  const out: Array<{ event: string; data: any }> = [];
  for (const block of raw.split("\n\n")) {
    const ev = block.split("\n").find((l) => l.startsWith("event: "));
    const da = block.split("\n").find((l) => l.startsWith("data: "));
    if (ev && da) out.push({ event: ev.slice(7), data: JSON.parse(da.slice(6)) });
  }
  return out;
}

describe("upstream config + model mapping", () => {
  it("disabled without env", () => {
    clearEnv();
    expect(upstreamEnabled()).toBe(false);
    expect(upstreamConfig()).toBe(null);
  });

  it("haiku→small, everything else→big", () => {
    const cfg = upstreamConfig()!;
    expect(mapUpstreamModel("claude-haiku-4-5", cfg)).toBe("gpt-small");
    expect(mapUpstreamModel("haiku", cfg)).toBe("gpt-small");
    expect(mapUpstreamModel("claude-sonnet-5", cfg)).toBe("gpt-big");
    expect(mapUpstreamModel("claude-opus-5", cfg)).toBe("gpt-big");
  });
});

describe("handleUpstreamChat (OpenAI passthrough)", () => {
  it("remaps the model, keeps tools+stream, forwards auth", async () => {
    let captured: { url: string; init: any; body: any } | null = null;
    const fakeFetch = (async (url: string, init: any) => {
      captured = { url: String(url), init, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: null }, finish_reason: "tool_calls" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const res = await handleUpstreamChat({
      model: "claude-sonnet-5",
      max_tokens: 128,
      stream: true,
      tools: [{ type: "function", function: { name: "bash", description: "", parameters: { type: "object", properties: {} } } }],
      messages: [{ role: "user", content: "hi" }],
    } as any, fakeFetch);

    expect(res.status).toBe(200);
    expect(captured!.url).toBe(`${BASE}/v1/chat/completions`);
    expect(captured!.init.headers.Authorization).toBe("Bearer sk-test");
    expect(captured!.body.model).toBe("gpt-big");
    expect(captured!.body.stream).toBe(true);
    expect(captured!.body.tools).toHaveLength(1);
  });
});

describe("handleUpstreamMessages (Anthropic translation)", () => {
  it("non-stream converts OpenAI reply into an Anthropic message", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "Hello from upstream!" }, finish_reason: "stop" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;

    const res = await handleUpstreamMessages({
      model: "claude-sonnet-5",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
    } as any, undefined, fakeFetch);

    expect(res.status).toBe(200);
    const msg = await res.json();
    expect(msg.type).toBe("message");
    expect(msg.model).toBe("claude-sonnet-5"); // requested name echoed back
    expect(msg.content[0]).toEqual({ type: "text", text: "Hello from upstream!" });
    expect(msg.stop_reason).toBe("end_turn");
  });

  it("stream converts text + tool_calls chunks into Anthropic blocks", async () => {
    const openaiChunks = [
      'data: {"choices":[{"delta":{"role":"assistant","content":"Checking"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"bash","arguments":"{\\"co"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"mmand\\":\\"ls\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const fakeFetch = (async () => sse(openaiChunks)) as unknown as typeof fetch;

    const res = await handleUpstreamMessages({
      model: "claude-sonnet-5",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "run ls" }],
    } as any, undefined, fakeFetch);

    const events = await collectSse(res);
    const names = events.map((e) => e.event);
    expect(names[0]).toBe("message_start");
    expect(names.at(-1)).toBe("message_stop");
    expect(names).toContain("message_delta");

    const starts = events.filter((e) => e.event === "content_block_start");
    expect(starts[0].data.content_block.type).toBe("text");
    const textDeltas = events.filter((e) => e.data?.delta?.type === "text_delta");
    expect(textDeltas.map((e) => e.data.delta.text).join("")).toBe("Checking");

    const toolStart = starts.find((e) => e.data.content_block.type === "tool_use");
    expect(toolStart!.data.content_block.name).toBe("bash");
    // Clients concatenate ALL input_json_delta fragments for a block.
    const args = events
      .filter((e) => e.event === "content_block_delta" && e.data?.delta?.type === "input_json_delta" && e.data.index === toolStart!.data.index)
      .map((e) => e.data.delta.partial_json)
      .join("");
    expect(JSON.parse(args)).toEqual({ command: "ls" });

    const stop = events.find((e) => e.event === "message_delta");
    expect(stop!.data.delta.stop_reason).toBe("tool_use");
  });
});
