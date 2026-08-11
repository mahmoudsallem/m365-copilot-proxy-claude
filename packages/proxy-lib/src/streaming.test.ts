import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";

// Replace core's ModelSession with a scripted fake so we can exercise the handler's
// streaming path with no auth/WebSocket. Everything else in core stays real.
const scripted: {
  deltas: string[];
  fullText?: string;
  sources?: unknown[];
  calls: Array<{ text: string; conversationId: string }>;
} = { deltas: [], calls: [] };

vi.mock("@m365-copilot/core", async (importActual) => {
  const actual = await importActual<typeof import("@m365-copilot/core")>();
  class FakeModelSession {
    turnCount = 0;
    conversationId = "conv-test";
    reset() { this.turnCount = 0; }
    newConversation() { this.conversationId = `conv-test-${crypto.randomUUID()}`; this.turnCount = 0; }
    async refreshAgent() { return false; }
    async run(text: string) {
      scripted.calls.push({ text, conversationId: this.conversationId });
      this.turnCount++;
      const deltas = scripted.deltas;
      const full = scripted.fullText ?? deltas.join("");
      const stream = {
        fullText: full,
        hasContent: true,
        images: [],
        sourceAttributions: scripted.sources ?? [],
        throttle: { current: 1, max: 600 },
        contentOrigin: "Claude",
        messageType: null as string | null,
        messageId: "m1",
        scores: null,
        turnCount: 1,
        turnState: "Completed",
        async *[Symbol.asyncIterator]() {
          for (const d of deltas) {
            await Promise.resolve(); // yield to the event loop between deltas
            yield d;
          }
        },
      };
      return stream;
    }
  }
  return { ...actual, ModelSession: FakeModelSession };
});

const { handleChatCompletion, SessionPool, ChatCompletionRequest } = await import("./index.js");

/** Drive one streaming request and collect the ordered content-delta strings. */
async function streamContents(deltas: string[], fullText?: string): Promise<string[]> {
  scripted.deltas = deltas;
  scripted.fullText = fullText;
  scripted.sources = [];
  const body = ChatCompletionRequest.parse({
    model: "m365-copilot",
    stream: true,
    messages: [{ role: "user", content: "hello" }],
  });
  const res = await handleChatCompletion(body, new SessionPool());
  expect(res.status).toBe(200);
  const text = await res.text();

  const contents: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6);
    if (payload === "[DONE]") continue;
    const chunk = JSON.parse(payload);
    const c = chunk.choices?.[0]?.delta?.content;
    if (typeof c === "string" && c.length > 0) contents.push(c);
  }
  return contents;
}

describe("incremental streaming (non-tool path)", () => {
  it("forwards deltas as separate chunks, not one buffered blob", async () => {
    const contents = await streamContents(["Hello", ", ", "world", "!"]);
    // Genuinely incremental: each delta is its own chunk.
    expect(contents.length).toBeGreaterThan(1);
    // Lossless and in-order: reconstructs the full answer exactly once.
    expect(contents.join("")).toBe("Hello, world!");
  });

  it("returns the effective cryptographic session id on every response", async () => {
    scripted.deltas = ["ok"];
    scripted.fullText = "ok";
    scripted.sources = [];
    const body = ChatCompletionRequest.parse({
      model: "m365-copilot",
      stream: true,
      messages: [{ role: "user", content: "session header" }],
    });
    const id = randomUUID();
    const response = await handleChatCompletion(body, new SessionPool(), { sessionId: id });
    expect(response.headers.get("x-m365-session-id")).toBe(id);
    await response.text();
  });

  it("surfaces only captured grounding attributions in response metadata", async () => {
    scripted.deltas = ["grounded answer"];
    scripted.fullText = "grounded answer";
    scripted.sources = [{
      sourceId: "src-1",
      url: "https://example.test/source",
      title: "Primary source",
      provider: "Bing",
    }];
    const body = ChatCompletionRequest.parse({
      model: "quick",
      messages: [{ role: "user", content: "fresh fact" }],
    });
    const response = await handleChatCompletion(body, new SessionPool(), { sessionId: randomUUID() });
    const payload = await response.json() as any;
    expect(payload.usage.x_m365_source_attributions).toEqual(scripted.sources);
    expect(payload.usage).toMatchObject({
      x_m365_requested_model: "quick",
      x_m365_resolved_model: "quick",
      x_m365_tone: "Gpt_Quick",
      x_m365_agent_route: "agentless",
      x_m365_certification: "experimental",
      x_m365_upstream_attempts: 1,
      x_m365_recovery_events: [],
      x_m365_output_chars: "grounded answer".length,
      x_m365_tool_calls: 0,
    });
    expect(JSON.stringify(payload.usage)).not.toContain("fresh fact");
  });

  it("rotates and sends the entire compacted transcript, not a delta", async () => {
    scripted.deltas = ["ok"];
    scripted.fullText = "ok";
    scripted.sources = [];
    scripted.calls = [];
    const pool = new SessionPool({}, { maxConcurrency: 1 });
    const sessionId = randomUUID();
    const original = ChatCompletionRequest.parse({
      model: "quick",
      messages: [
        { role: "user", content: "implement task" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "old follow-up" },
      ],
    });
    await (await handleChatCompletion(original, pool, { sessionId })).text();

    const compacted = ChatCompletionRequest.parse({
      model: "quick",
      messages: [
        { role: "user", content: "implement task" },
        { role: "assistant", content: "COMPACTED STATE: inspected src and changed a.ts" },
        { role: "user", content: "continue from compacted state" },
      ],
    });
    await (await handleChatCompletion(compacted, pool, { sessionId })).text();

    expect(scripted.calls).toHaveLength(2);
    expect(scripted.calls[1].conversationId).not.toBe(scripted.calls[0].conversationId);
    expect(scripted.calls[1].text).toContain("COMPACTED STATE: inspected src and changed a.ts");
    expect(scripted.calls[1].text).toContain("continue from compacted state");
    expect(scripted.calls[1].text).not.toBe("Please continue.");
  });

  it("emits the trailing remainder once when the final text outruns the delta stream", async () => {
    // Deltas cover a prefix ("Hello wor"); the authoritative full text is longer —
    // the renderer must send the "ld" tail exactly once, never re-send the prefix.
    const contents = await streamContents(["Hello ", "wor"], "Hello world");
    expect(contents.join("")).toBe("Hello world");
    // No duplicated prefix.
    expect(contents.join("").match(/Hello/g)?.length).toBe(1);
  });
});
