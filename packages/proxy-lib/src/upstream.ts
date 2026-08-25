// Generic OpenAI-upstream mode: when OPENAI_UPSTREAM_BASE_URL is configured,
// the proxy routes requests to THAT backend instead of M365 — giving any
// Anthropic client (Claude Code) access to any OpenAI-compatible API.
// Same job as LiteLLM-based bridges, zero extra runtime deps:
//   /v1/chat/completions  → near-verbatim passthrough (model remapped)
//   /v1/messages          → Anthropic⇄OpenAI translation (reuses existing converters)
import { createLogger } from "@m365-copilot/core";
import type { ChatBody } from "./schemas.js";
import { toOpenAIChatRequest, fromOpenAIChatResponse, type AnthropicBody } from "./anthropic.js";

const log = createLogger("upstream");

export interface UpstreamConfig {
  baseUrl: string;
  apiKey: string;
  bigModel: string;
  smallModel: string;
}

export function upstreamConfig(): UpstreamConfig | null {
  const baseUrl = process.env.OPENAI_UPSTREAM_BASE_URL;
  if (!baseUrl) return null;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey: process.env.OPENAI_UPSTREAM_API_KEY ?? "",
    bigModel: process.env.UPSTREAM_BIG_MODEL ?? "gpt-4.1",
    smallModel: process.env.UPSTREAM_SMALL_MODEL ?? "gpt-4.1-mini",
  };
}

export function upstreamEnabled(): boolean {
  return upstreamConfig() !== null;
}

/** Claude-style request names map like the harnesses send them: haiku→small, everything else→big. */
export function mapUpstreamModel(requested: string, cfg: UpstreamConfig): string {
  return /haiku/i.test(requested) ? cfg.smallModel : cfg.bigModel;
}

function upstreamHeaders(cfg: UpstreamConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
  };
}

/**
 * POST /v1/chat/completions in upstream mode — near-verbatim reverse proxy:
 * only the model name is remapped (harnesses send claude-* names). Streaming
 * passes through untouched (the upstream already speaks OpenAI SSE).
 */
export async function handleUpstreamChat(
  body: ChatBody,
  injectedFetch: typeof fetch = fetch,
): Promise<Response> {
  const cfg = upstreamConfig()!;
  const payload = {
    ...body,
    model: mapUpstreamModel(body.model, cfg),
    // M365-specific extension fields mean nothing to a generic upstream.
    tool_choice: body.tool_choice === "none" ? "none" : body.tool_choice,
  };
  delete (payload as Record<string, unknown>).user;
  const res = await injectedFetch(`${cfg.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: upstreamHeaders(cfg),
    body: JSON.stringify(payload),
    signal: undefined,
  });
  log.info(`upstream chat ${res.status} model=${payload.model}`);
  return new Response(res.body, {
    status: res.status,
    headers: { "Content-Type": res.headers.get("Content-Type") ?? "application/json" },
  });
}

/** Rough count_tokens stand-in for upstream mode (no shared tokenizer exists). */
export function estimateUpstreamTokens(messages: unknown[]): number {
  let chars = 0;
  for (const m of messages as Array<{ content?: unknown }>) {
    const c = m?.content;
    chars += typeof c === "string" ? c.length : JSON.stringify(c ?? "").length;
  }
  return Math.max(1, Math.ceil(chars / 4));
}

/**
 * POST /v1/messages in upstream mode: translate Anthropic → OpenAI, forward,
 * convert the reply back. Non-stream uses the existing fromOpenAIChatResponse
 * converter; stream converts chunk-by-chunk into Anthropic SSE events.
 */
export async function handleUpstreamMessages(
  body: AnthropicBody,
  signal?: AbortSignal,
  injectedFetch: typeof fetch = fetch,
): Promise<Response> {
  const cfg = upstreamConfig()!;
  const requested = body.model;
  const chat = toOpenAIChatRequest(body);
  chat.model = mapUpstreamModel(requested, cfg);

  const res = await injectedFetch(`${cfg.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: upstreamHeaders(cfg),
    body: JSON.stringify({ ...chat, stream: !!body.stream }),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    log.error(`upstream messages ${res.status}: ${detail.slice(0, 200)}`);
    return new Response(JSON.stringify({
      type: "error",
      error: { type: "api_error", message: `Upstream ${res.status}: ${detail.slice(0, 300)}` },
    }), { status: 502, headers: { "Content-Type": "application/json" } });
  }

  if (!body.stream) {
    const payload = await res.json();
    const message = fromOpenAIChatResponse(payload, requested);
    return new Response(JSON.stringify(message), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return convertOpenAiSseToAnthropic(res, requested);
}

/**
 * Convert an OpenAI chat.completion.chunk SSE stream into Anthropic Messages SSE.
 * Text deltas → one text block; delta.tool_calls are accumulated per index into
 * tool_use blocks (input_json_delta carries the argument fragments verbatim).
 */
export function convertOpenAiSseToAnthropic(upstreamRes: Response, requestedModel: string): Response {
  const encoder = new TextEncoder();
  const dec = new TextDecoder();
  const id = `msg_${crypto.randomUUID().replace(/-/g, "")}`;

  return new Response(new ReadableStream({
    async start(controller) {
      const send = (name: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`));
      const reader = upstreamRes.body!.getReader();

      send("message_start", {
        type: "message_start",
        message: {
          id, type: "message", role: "assistant", model: requestedModel,
          content: [], stop_reason: null, stop_sequence: null,
          usage: {
            input_tokens: 0, output_tokens: 0,
            cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
          },
        },
      });

      let nextIndex = 0;
      let textIndex: number | null = null;
      let sent = "";
      let outTokens = 0;
      const toolBlocks = new Map<number, {
        index: number | null; startSent: boolean; id: string; name: string; args: string[];
      }>();
      let stopReason: string | null = null;
      let buf = "";

      const openText = () => {
        if (textIndex == null) {
          textIndex = nextIndex++;
          send("content_block_start", { type: "content_block_start", index: textIndex, content_block: { type: "text", text: "" } });
        }
      };
      const closeText = () => {
        if (textIndex != null) {
          send("content_block_stop", { type: "content_block_stop", index: textIndex });
          textIndex = null;
        }
      };

      const handleChunk = (evt: any) => {
        const choice = evt?.choices?.[0];
        if (!choice) return;
        const delta = choice.delta ?? {};
        const text = typeof delta.content === "string" && delta.content.length > 0
          ? delta.content
          : typeof (delta as { text?: unknown }).text === "string" ? (delta as { text: string }).text : "";
        if (text.length > 0) {
          openText();
          sent += text;
          send("content_block_delta", { type: "content_block_delta", index: textIndex!, delta: { type: "text_delta", text } });
        }
        for (const tc of delta.tool_calls ?? []) {
          const slot = Number(tc.index ?? 0);
          let block = toolBlocks.get(slot);
          if (!block) {
            block = { index: null, startSent: false, id: "", name: "", args: [] };
            toolBlocks.set(slot, block);
          }
          if (tc.id) block.id = String(tc.id);
          if (tc.function?.name) block.name = String(tc.function.name);
          if (typeof tc.function?.arguments === "string") block.args.push(tc.function.arguments);
          // Anthropic needs `name` on content_block_start — most upstreams send
          // the full name in the first fragment, so start lazily once known.
          if (!block.startSent && block.name) {
            closeText();
            block.index = nextIndex++;
            block.startSent = true;
            send("content_block_start", { type: "content_block_start", index: block.index, content_block: { type: "tool_use", id: block.id || `call_${slot}`, name: block.name, input: {} } });
            if (block.args.length) {
              send("content_block_delta", { type: "content_block_delta", index: block.index, delta: { type: "input_json_delta", partial_json: block.args.join("") } });
              block.args.length = 0;
            }
          }
        }
        if (choice.finish_reason) {
          stopReason = choice.finish_reason === "tool_calls" ? "tool_use"
            : choice.finish_reason === "length" ? "max_tokens" : "end_turn";
        }
        // Final chunks carry cumulative usage — capture for message_delta so the
        // client's context-window math isn't fed constant zeros.
        const u = evt?.usage ?? choice.usage;
        if (u && typeof u.completion_tokens === "number") outTokens = u.completion_tokens;
      };

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            const data = line.slice(6).trim();
            if (!data || data === "[DONE]") continue;
            try { handleChunk(JSON.parse(data)); } catch { /* skip malformed */ }
          }
        }
      } catch (err: any) {
        send("error", { type: "error", error: { type: "api_error", message: err?.message ?? "upstream stream error" } });
      }

      closeText();
      for (const [, block] of [...toolBlocks.entries()].sort((a, b) => a[0] - b[0])) {
        if (!block.startSent) {
          // Stream ended before any name arrived — emit an unknown-tool shell so
          // block indexes stay consistent, then close it.
          block.index = nextIndex++;
          send("content_block_start", { type: "content_block_start", index: block.index, content_block: { type: "tool_use", id: block.id || `call_unknown`, name: "unknown", input: {} } });
        }
        if (block.args.length) {
          send("content_block_delta", { type: "content_block_delta", index: block.index!, delta: { type: "input_json_delta", partial_json: block.args.join("") } });
        }
        send("content_block_stop", { type: "content_block_stop", index: block.index! });
      }
      void sent;
      send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason ?? "end_turn", stop_sequence: null },
        usage: { output_tokens: outTokens },
      });
      send("message_stop", { type: "message_stop" });
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}
