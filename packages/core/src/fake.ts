import { createLogger } from "./log.js";
import type { CopilotStream } from "./copilot.js";
import type { ModelTransport } from "./model.js";

const log = createLogger("fake");

/**
 * Scripted offline backend for M365_FAKE_MODE and tests.
 *
 * Speaks the same protocol shape as the real pipeline so the FULL stack
 * (fenced tool formatting → response parsing → OpenAI/Anthropic translation)
 * is exercised without auth, WebSockets, or quota:
 *
 * - Prompt contains a fenced tool manifest (`<system>` + ```bash) and no
 *   `<tool_response>` yet  -> emits ONE ```bash tool call (the shell-routing loop).
 * - Prompt contains `<tool_response>` (a result came back)          -> emits a final text answer.
 * - Anything else                                                    -> echoes a plain answer.
 *
 * Deterministic; every conversationId gets its own turn counter.
 */

export interface FakeTransportOptions {
  /** Called with each incoming prompt — lets tests assert formatting/injection. */
  onPrompt?: (text: string, conversationId: string) => void;
  /** Override the generated ```bash command on tool turns. */
  command?: string;
  /** Override the final-answer template; `${responses}` = number of tool results seen. */
  finalText?: (responses: number) => string;
  /** Split streamed output into chunks of this many chars (default 7). */
  chunkSize?: number;
  /** Per-turn artificial latency in ms (default 0). */
  latencyMs?: number;
}

function makeStream(text: string, opts: { chunkSize: number; throttle: { current: number; max: number }; turnCount: number }): CopilotStream {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += opts.chunkSize) chunks.push(text.slice(i, i + opts.chunkSize));
  if (chunks.length === 0) chunks.push("");
  return {
    fullText: text,
    hasContent: text.length > 0,
    images: [],
    throttle: opts.throttle,
    contentOrigin: "Fake",
    messageType: null,
    messageId: `fake-${crypto.randomUUID()}`,
    scores: { dea_violation: 1e-13 },
    turnCount: opts.turnCount,
    turnState: "Completed",
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) {
        await new Promise((r) => setTimeout(r, 0));
        yield c;
      }
    },
  };
}

export class FakeTransport implements ModelTransport {
  private turns = new Map<string, { n: number; responses: number }>();
  readonly prompts: Array<{ text: string; conversationId: string }> = [];

  constructor(private options: FakeTransportOptions = {}) {}

  private stateFor(conversationId: string): { n: number; responses: number } {
    let s = this.turns.get(conversationId);
    if (!s) {
      s = { n: 0, responses: 0 };
      this.turns.set(conversationId, s);
    }
    return s;
  }

  reset(): void {
    // A "reconnect" keeps scripted per-conversation counters — nothing to drop.
  }

  async chat(args: {
    text: string;
    sessionId: string;
    conversationId: string;
    latencyMs?: number;
  } & Record<string, unknown>): Promise<CopilotStream> {
    this.prompts.push({ text: args.text, conversationId: args.conversationId });
    this.options.onPrompt?.(args.text, args.conversationId);

    const state = this.stateFor(args.conversationId);
    state.n += 1;
    // Count REAL tool results only — the framing instructions mention bare
    // `<tool_response>` tags when teaching the format, while actual results are
    // rendered as `<tool_response name="..." call_id="...">`.
    if (/<tool_response\s+name=/.test(args.text)) state.responses += 1;

    const hasToolManifest = args.text.includes("<system>") && args.text.includes("```bash");
    let text: string;
    if (state.responses > 0) {
      const responses = state.responses;
      text = this.options.finalText?.(responses)
        ?? `Task complete after ${responses} tool result(s). FAKE_FINAL cid=${args.conversationId.slice(0, 8)} turn=${state.n}`;
    } else if (hasToolManifest) {
      const cmd = this.options.command ?? `echo fake-turn-${state.n}`;
      text = "```bash\n" + cmd + "\n```";
    } else {
      text = `FAKE_ECHO turn=${state.n}: ${args.text.slice(0, 80).replace(/\s+/g, " ")}`;
    }

    log.info(`fake turn n=${state.n} responses=${state.responses} -> ${text.length} chars`);
    const latency = this.options.latencyMs ?? 0;
    if (latency > 0) await new Promise((r) => setTimeout(r, latency));
    return makeStream(text, {
      chunkSize: this.options.chunkSize ?? 7,
      throttle: { current: Math.min(state.n, 599), max: 600 },
      turnCount: state.n,
    });
  }
}
