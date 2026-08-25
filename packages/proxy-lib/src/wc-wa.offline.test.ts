import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApp } from "./index.js";
import { toneHealth } from "./health.js";
import type { CopilotStream, ModelTransport } from "@m365-copilot/core";

/**
 * OFFLINE coverage for the W-B/W-C/W-A handler work:
 *   - one-call-per-turn gate (M365_ALLOW_MULTI_TOOL)
 *   - ToolSearch progressive discovery round-trip
 *   - inline tone failover + breaker on the F16.3 outage signature
 * Uses a scripted ModelTransport — no auth, no network, no quota.
 */

function makeStream(text: string, over: Partial<CopilotStream> = {}): CopilotStream {
  return {
    fullText: text,
    hasContent: text.length > 0,
    images: [],
    throttle: { current: 1, max: 600 },
    contentOrigin: "Fake",
    messageType: null,
    messageId: `fake-${crypto.randomUUID()}`,
    scores: {},
    turnCount: 1,
    turnState: "Completed",
    async *[Symbol.asyncIterator]() {
      yield text;
    },
    ...over,
  };
}

type Responder = (args: { text: string; tone?: string; n: number }) => CopilotStream;

class ScriptedTransport implements ModelTransport {
  readonly prompts: Array<{ text: string; tone?: string }> = [];
  private counts = new Map<string, number>();
  constructor(private responder: Responder) {}
  reset(): void {}
  async chat(args: { text: string; tone?: string } & Record<string, unknown>): Promise<CopilotStream> {
    const key = `${args.tone ?? "magic"}:${this.prompts.length}`;
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    this.prompts.push({ text: args.text, tone: args.tone });
    return this.responder({ text: args.text, tone: args.tone, n });
  }
}

function makeApp(transport: ModelTransport) {
  return createApp({ getToken: async () => "fake-token", useAgent: false, transport });
}

const BASH_TOOL = {
  type: "function" as const,
  function: {
    name: "bash",
    description: "Run a shell command",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
};
const READ_TOOL = {
  type: "function" as const,
  function: {
    name: "read_file",
    description: "Read a file from disk and return its contents verbatim",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
};

function openaiRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.M365_DEBUG = "1"; // route handler logs into ~/.config/opencode-m365/debug.log
  process.env.M365_EMPTY_RETRY_DELAY_MS = "1"; // keep failover tests fast
  process.env.M365_CONVERSATION_START_GAP_MS = "1"; // TurnGate stagger off for offline tests
  delete process.env.M365_NO_MULTI_TOOL;
  delete process.env.M365_ALLOWED_TOOLS;
  delete process.env.M365_MAX_TOOLS;
  delete process.env.M365_NO_TONE_FAILOVER;
  toneHealth.resetForTests();
});
afterEach(() => {
  delete process.env.M365_NO_MULTI_TOOL;
  delete process.env.M365_ALLOWED_TOOLS;
  delete process.env.M365_MAX_TOOLS;
  delete process.env.M365_NO_TONE_FAILOVER;
  delete process.env.M365_EMPTY_RETRY_DELAY_MS;
  delete process.env.M365_CONVERSATION_START_GAP_MS;
  toneHealth.resetForTests();
});

describe("batched tool calls (default ON, M365_NO_MULTI_TOOL off-switch)", () => {
  const twoFences = "Let me check both.\n```bash\necho first\n```\n```bash\necho second\n```";

  it("default: batches pass through to the client", async () => {
    expect(process.env.M365_NO_MULTI_TOOL).toBeUndefined();
    const transport = new ScriptedTransport(() => makeStream(twoFences));
    const app = makeApp(transport);
    const res = await app.fetch(openaiRequest({
      model: "claude-sonnet",
      max_tokens: 256,
      tools: [BASH_TOOL],
      messages: [{ role: "user", content: "do two things" }],
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.tool_calls).toHaveLength(2);
  });

  it("M365_NO_MULTI_TOOL=1 truncates to the FIRST call", async () => {
    process.env.M365_NO_MULTI_TOOL = "1";
    const transport = new ScriptedTransport(() => makeStream(twoFences));
    const app = makeApp(transport);
    const res = await app.fetch(openaiRequest({
      model: "claude-sonnet",
      max_tokens: 256,
      tools: [BASH_TOOL],
      messages: [{ role: "user", content: "do two things" }],
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.tool_calls).toHaveLength(1);
    expect(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments)).toEqual({ command: "echo first" });
  });
});

describe("ToolSearch progressive discovery (W-A)", () => {
  it("hides deferred schemas behind ToolSearch, promotes matches, executes the real tool", async () => {
    process.env.M365_MAX_TOOLS = "1"; // advertise only bash; read_file becomes deferred
    let phase = 0;
    const transport = new ScriptedTransport(({ text }) => {
      phase += 1;
      if (phase === 1) {
        // First prompt advertises bash + ToolSearch (+ Task) but NOT the
        // deferred read_file SCHEMA (its description string must be absent).
        expect(text.includes("Read a file.")).toBe(false);
        expect(text).toContain("ToolSearch");
        // Body-style arg: the whole fence body is the search query.
        return makeStream("```ToolSearch\nread a file\n```");
      }
      if (phase === 2) {
        // Injection turn: the promoted definition must be rendered here.
        expect(text).toContain("[ToolSearch results for \"read a file\"]");
        expect(text).toContain("NOW AVAILABLE");
        expect(text).toContain("read_file");
        // Body-style arg: single free-form param = the fence body.
        return makeStream("```read_file\npackage.json\n```");
      }
      if (phase >= 3) {
        return makeStream("Exploration complete — final answer.");
      }
      throw new Error(`unexpected extra transport turn ${phase}: ${text.slice(0, 120)}`);
    });
    const app = makeApp(transport);
    const res = await app.fetch(openaiRequest({
      model: "claude-sonnet",
      max_tokens: 256,
      tools: [BASH_TOOL, READ_TOOL],
      messages: [{ role: "user", content: "read package.json please" }],
    }));
    const text = await res.text();
    expect(res.status, text).toBe(200);
    const body = JSON.parse(text);
    // The client sees ONE genuine tool_use for its OWN declared tool.
    expect(body.choices[0].message.tool_calls).toHaveLength(1);
    expect(body.choices[0].message.tool_calls[0].function.name).toBe("read_file");
    expect(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments)).toEqual({ path: "package.json" });
  });
});

describe("guarded live streaming in tool mode (W-D)", () => {
  // A preamble followed by a fence, split into small chunks so the fence
  // straddles boundaries — the guard must never leak ``` bytes as content.
  const streamed = makeStream("Working on it now.\n```bash\necho hi\n```");
  function* chunks(s: string) { for (let i = 0; i < s.length; i += 5) yield s.slice(i, i + 5); }
  const chunked: CopilotStream = {
    ...streamed,
    async *[Symbol.asyncIterator]() { for (const c of chunks(streamed.fullText)) { await new Promise((r) => setTimeout(r, 0)); yield c; } },
  };

  it("openai stream: prose arrives BEFORE turn end; no fence bytes ever leak", async () => {
    const transport = new ScriptedTransport(() => chunked);
    const app = makeApp(transport);
    const res = await app.fetch(openaiRequest({
      model: "claude-sonnet", max_tokens: 128, stream: true,
      tools: [BASH_TOOL],
      messages: [{ role: "user", content: "do the thing" }],
    }));
    expect(res.status).toBe(200);
    const raw = await res.text();
    const contents: string[] = [];
    const calls: any[] = [];
    for (const chunk of raw.split("\n\n")) {
      if (!chunk.startsWith("data: ") || chunk.includes("[DONE]")) continue;
      try {
        const evt = JSON.parse(chunk.slice(6));
        const d = evt.choices?.[0]?.delta;
        if (d?.content) contents.push(d.content);
        if (d?.tool_calls) calls.push(...d.tool_calls);
      } catch {}
    }
    expect(contents.join("").includes("```")).toBe(false);       // fence bytes never leak
    expect(contents.join("")).toContain("Working on it");         // prose arrived live
    expect(calls.length).toBeGreaterThan(0);                      // and the call still lands
  });

  it("anthropic non-stream carries prose text block before tool_use", async () => {
    const transport = new ScriptedTransport(() => makeStream("Checking first.\n```bash\necho hi\n```"));
    const app = makeApp(transport);
    const res = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet", max_tokens: 128,
        tools: [{ name: "bash", description: "Run shell", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }],
        messages: [{ role: "user", content: "go" }],
      }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content[0].type).toBe("text");
    expect(body.content[0].text).toContain("Checking first");
    expect(body.content[1].type).toBe("tool_use");
    expect(body.content[1].name).toBe("bash");
  });
});

describe("tone-health failover (W-C)", () => {
  const outage = () => makeStream("", {
    hasContent: false,
    messageType: "Progress",
    throttle: { current: 2, max: 600 },
    turnState: "Failed",
  });

  it("inline-fails-over to gpt-5.5 on the F16.3 signature and returns the healthy answer", async () => {
    const seenTones: Array<string | undefined> = [];
    const transport = new ScriptedTransport(({ tone }) => {
      seenTones.push(tone);
      if (tone === "Claude_Sonnet") return outage();
      return makeStream("FAKE_HEALTHY_ANSWER");
    });
    const app = makeApp(transport);
    const res = await app.fetch(openaiRequest({
      model: "claude-sonnet",
      max_tokens: 256,
      messages: [{ role: "user", content: "hello" }],
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toContain("FAKE_HEALTHY_ANSWER");
    expect(seenTones).toContain("Claude_Sonnet");
    expect(seenTones).toContain("Claude_Opus"); // first fallback in the chain
  });

  it("breaker routes subsequent requests away from the failed tone", async () => {
    const seenTones: Array<string | undefined> = [];
    const transport = new ScriptedTransport(({ tone }) => {
      seenTones.push(tone);
      if (tone === "Claude_Sonnet") return outage();
      return makeStream("FAKE_OK");
    });
    const app = makeApp(transport);
    for (let i = 0; i < 3; i++) {
      const res = await app.fetch(openaiRequest({
        model: "claude-sonnet",
        max_tokens: 64,
        messages: [{ role: "user", content: `ping ${i}` }],
      }));
      expect(res.status).toBe(200);
    }
    // After threshold failures the breaker is OPEN: this request never touches sonnet.
    seenTones.length = 0;
    const res = await app.fetch(openaiRequest({
      model: "claude-sonnet",
      max_tokens: 64,
      messages: [{ role: "user", content: "again" }],
    }));
    expect(res.status).toBe(200);
    expect(seenTones).not.toContain("Claude_Sonnet");
    expect(seenTones).toContain("Claude_Opus"); // first fallback tried directly
  });

  it("M365_NO_TONE_FAILOVER=1 keeps requests on the failing tone", async () => {
    process.env.M365_NO_TONE_FAILOVER = "1";
    const seenTones: Array<string | undefined> = [];
    const transport = new ScriptedTransport(({ tone }) => {
      seenTones.push(tone);
      if (tone === "Claude_Sonnet") return outage();
      return makeStream("FAKE_OK");
    });
    const app = makeApp(transport);
    const res = await app.fetch(openaiRequest({
      model: "claude-sonnet",
      max_tokens: 64,
      messages: [{ role: "user", content: "stuck" }],
    }));
    expect(res.status).toBeGreaterThanOrEqual(400); // surfaces the upstream error instead
    expect(new Set(seenTones)).toEqual(new Set(["Claude_Sonnet"]));
  });
});
