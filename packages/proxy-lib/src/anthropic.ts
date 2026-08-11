import { z } from "zod/v4";
import {
  CONSERVATIVE_MODEL_LIMITS,
  getAvailableModels,
  getDefaultModel,
} from "@m365-copilot/core";
import { ChatCompletionRequest } from "./schemas.js";
import { handleChatCompletion, type SessionPool } from "./handler.js";

const TextBlock = z.object({
  type: z.literal("text"),
  text: z.string(),
}).passthrough();

const ToolUseBlock = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown().optional().default({}),
}).passthrough();

const ToolResultBlock = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  // Image/document blocks cannot currently be forwarded to M365 faithfully.
  // Reject them at the boundary instead of silently reducing them to empty text.
  content: z.union([z.string(), z.array(TextBlock)]).optional().default(""),
  is_error: z.boolean().optional(),
}).passthrough();

// Fail closed on thinking, redacted_thinking, image, document, server_tool_use,
// and future block types. Silently discarding one corrupts the transcript and can
// make a coding agent act on a result it never actually received.
const ContentBlock = z.discriminatedUnion("type", [TextBlock, ToolUseBlock, ToolResultBlock]);

const AnthropicMessage = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(ContentBlock)]),
}).superRefine((message, ctx) => {
  if (!Array.isArray(message.content)) return;
  message.content.forEach((block, index) => {
    const allowed = message.role === "assistant"
      ? block.type === "text" || block.type === "tool_use"
      : block.type === "text" || block.type === "tool_result";
    if (!allowed) {
      ctx.addIssue({
        code: "custom",
        path: ["content", index, "type"],
        message: `${block.type} is not supported in an Anthropic ${message.role} message`,
      });
    }
  });
});

const AnthropicTool = z.object({
  name: z.string(),
  description: z.string().optional(),
  input_schema: z.unknown().optional(),
}).passthrough();

const AnthropicToolChoice = z.union([
  z.object({ type: z.literal("auto"), disable_parallel_tool_use: z.boolean().optional() }),
  z.object({ type: z.literal("any"), disable_parallel_tool_use: z.boolean().optional() }),
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("tool"), name: z.string(), disable_parallel_tool_use: z.boolean().optional() }),
]);

export const AnthropicMessagesRequest = z.object({
  model: z.string().min(1),
  max_tokens: z.number().int().positive().optional().default(CONSERVATIVE_MODEL_LIMITS.maxOutputTokens),
  messages: z.array(AnthropicMessage).min(1),
  system: z.union([z.string(), z.array(TextBlock)]).optional(),
  tools: z.array(AnthropicTool).optional(),
  tool_choice: AnthropicToolChoice.optional(),
  stream: z.boolean().optional().default(false),
  temperature: z.number().optional(),
  stop_sequences: z.array(z.string()).optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export type AnthropicBody = z.infer<typeof AnthropicMessagesRequest>;

type OpenAIMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
};

function toolResultText(value: z.infer<typeof ToolResultBlock>["content"]): string {
  if (typeof value === "string") return value;
  return value.map((item) => item.text).join("\n");
}

function systemText(system: AnthropicBody["system"]): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system.map((block) => block.text).join("\n\n");
}

function anthropicMessagesToOpenAI(body: AnthropicBody): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];
  const toolNames = new Map<string, string>();
  const system = systemText(body.system);
  if (system) messages.push({ role: "system", content: system });

  for (const message of body.messages) {
    if (typeof message.content === "string") {
      messages.push({ role: message.role, content: message.content });
      continue;
    }

    if (message.role === "assistant") {
      const text = message.content
        .filter((block): block is z.infer<typeof TextBlock> => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const toolCalls = message.content
        .filter((block): block is z.infer<typeof ToolUseBlock> => block.type === "tool_use")
        .map((block) => {
          toolNames.set(block.id, block.name);
          return {
            id: block.id,
            type: "function" as const,
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          };
        });
      messages.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    let pendingText: string[] = [];
    const flushText = () => {
      if (pendingText.length) {
        messages.push({ role: "user", content: pendingText.join("\n") });
        pendingText = [];
      }
    };
    for (const block of message.content) {
      if (block.type === "text") {
        pendingText.push(block.text);
      } else if (block.type === "tool_result") {
        flushText();
        const result = toolResultText(block.content);
        messages.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          ...(toolNames.get(block.tool_use_id) ? { name: toolNames.get(block.tool_use_id) } : {}),
          content: block.is_error ? `[tool error]\n${result}` : result,
        });
      }
    }
    flushText();
    if (message.content.length === 0) messages.push({ role: "user", content: "" });
  }

  return messages;
}

function mapToolChoice(choice: AnthropicBody["tool_choice"]) {
  if (!choice || choice.type === "auto") return "auto" as const;
  if (choice.type === "any") return "required" as const;
  if (choice.type === "none") return "none" as const;
  return { type: "function" as const, function: { name: choice.name } };
}

const M365_MODEL_IDS = new Set(getAvailableModels());

/**
 * Claude Code only accepts gateway-discovered model IDs beginning with `claude`
 * or `anthropic`. Keep that transport-only prefix out of the M365 model catalog.
 */
export const CLAUDE_GATEWAY_MODEL_PREFIX = "claude-m365--";

export function toClaudeGatewayModelId(model: string): string {
  return `${CLAUDE_GATEWAY_MODEL_PREFIX}${model}`;
}

/**
 * Claude Code's /model picker only knows Anthropic catalog IDs. If a user picks
 * Opus/Sonnet there, do not forward that unrecognised ID into M365 and poison an
 * otherwise healthy conversation. Explicit M365 catalog IDs still pass through.
 */
export function resolveM365Model(requested: string): string {
  if (requested.startsWith(CLAUDE_GATEWAY_MODEL_PREFIX)) {
    const model = requested.slice(CLAUDE_GATEWAY_MODEL_PREFIX.length);
    if (M365_MODEL_IDS.has(model)) return model;
  }
  if (M365_MODEL_IDS.has(requested)) return requested;
  const configured = process.env.M365_CLAUDE_CODE_MODEL;
  return configured && M365_MODEL_IDS.has(configured) ? configured : getDefaultModel();
}

/** Translate Claude's Messages API request into the proxy's OpenAI Chat request. */
export function toOpenAIChatRequest(body: AnthropicBody) {
  return ChatCompletionRequest.parse({
    model: resolveM365Model(body.model),
    messages: anthropicMessagesToOpenAI(body),
    stream: false,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    tools: body.tools?.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema ?? { type: "object", properties: {} },
      },
    })),
    tool_choice: body.tools?.length ? mapToolChoice(body.tool_choice) : undefined,
  });
}

type AnthropicContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export interface AnthropicMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicContent[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens";
  stop_sequence: null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    x_m365_source_attributions?: unknown[];
  };
}

function parseToolInput(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return {}; }
}

/** Translate one completed OpenAI response into Anthropic Messages format. */
export function fromOpenAIChatResponse(payload: any, requestedModel: string): AnthropicMessageResponse {
  const choice = payload?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const content: AnthropicContent[] = [];
  if (typeof message.content === "string" && message.content.length) {
    content.push({ type: "text", text: message.content });
  }
  for (const call of message.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: String(call.id),
      name: String(call.function?.name ?? "unknown"),
      input: parseToolInput(String(call.function?.arguments ?? "{}")),
    });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });

  const finish = choice.finish_reason;
  const stopReason = finish === "tool_calls"
    ? "tool_use"
    : finish === "length" ? "max_tokens" : "end_turn";
  return {
    id: String(payload?.id ?? `msg_${crypto.randomUUID().replace(/-/g, "")}`),
    type: "message",
    role: "assistant",
    model: String(payload?.model ?? requestedModel),
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: Number(payload?.usage?.prompt_tokens ?? 0),
      output_tokens: Number(payload?.usage?.completion_tokens ?? 0),
      ...(Array.isArray(payload?.usage?.x_m365_source_attributions)
        ? { x_m365_source_attributions: payload.usage.x_m365_source_attributions }
        : {}),
    },
  };
}

function anthropicError(status: number, message: string, type = "api_error"): Response {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function event(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Render a completed Anthropic message as a standards-shaped SSE event stream. */
export function anthropicSse(message: AnthropicMessageResponse): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      const send = (name: string, data: unknown) => controller.enqueue(encoder.encode(event(name, data)));
      send("message_start", {
        type: "message_start",
        message: { ...message, content: [], stop_reason: null, stop_sequence: null },
      });
      message.content.forEach((block, index) => {
        if (block.type === "text") {
          send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
          if (block.text) send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
        } else {
          send("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
          });
          send("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
          });
        }
        send("content_block_stop", { type: "content_block_stop", index });
      });
      send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: message.stop_reason, stop_sequence: null },
        usage: { output_tokens: message.usage.output_tokens },
      });
      send("message_stop", { type: "message_stop" });
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}

async function produceAnthropic(
  body: AnthropicBody,
  pool: SessionPool,
  signal?: AbortSignal,
  sessionId?: string,
): Promise<AnthropicMessageResponse | Response> {
  const openai = toOpenAIChatRequest(body);
  const upstream = await handleChatCompletion(openai, pool, { signal, sessionId });
  if (!upstream.ok) {
    let message = `M365 upstream returned HTTP ${upstream.status}`;
    let upstreamType = "upstream_error";
    try {
      const payload = await upstream.json() as any;
      message = payload?.error?.message ?? message;
      upstreamType = payload?.error?.type ?? upstreamType;
    } catch {}

    // Claude Code retries 5xx/API errors aggressively (up to ten times), which
    // multiplies one empty M365 turn into a quota-burning retry storm. Empty or
    // deliberately disengaged M365 responses need a manual retry/new session,
    // not an immediate replay of the same request, so surface them as a
    // non-retryable Anthropic invalid_request_error. Preserve genuine rate limits
    // and other upstream failures with their normal retry semantics.
    const nonRetryable = upstreamType === "upstream_empty_response" || upstreamType === "disengaged";
    const status = nonRetryable ? 400 : upstream.status;
    const type = nonRetryable
      ? "invalid_request_error"
      : upstream.status === 429 ? "rate_limit_error" : "api_error";
    const response = anthropicError(status, message, type);
    const effectiveSessionId = upstream.headers.get("x-m365-session-id");
    if (effectiveSessionId) response.headers.set("X-M365-Session-ID", effectiveSessionId);
    return response;
  }
  let payload: unknown;
  try { payload = await upstream.json(); }
  catch {
    const response = anthropicError(502, "M365 upstream returned invalid JSON");
    const effectiveSessionId = sessionId ?? upstream.headers.get("x-m365-session-id");
    if (effectiveSessionId) response.headers.set("X-M365-Session-ID", effectiveSessionId);
    return response;
  }
  return fromOpenAIChatResponse(payload, body.model);
}

/** Handle an Anthropic Messages request, including early-flushed streaming with heartbeats. */
export async function handleAnthropicMessages(
  body: AnthropicBody,
  pool: SessionPool,
  signal?: AbortSignal,
  requestedSessionId?: string,
): Promise<Response> {
  let sessionId: string;
  try {
    const openai = toOpenAIChatRequest(body);
    sessionId = pool.getEffectiveSessionId(
      openai.messages,
      requestedSessionId,
      `anthropic:${openai.model}`,
    );
  } catch (error: any) {
    return anthropicError(400, error?.message ?? "Invalid M365 session", "invalid_request_error");
  }

  if (!body.stream) {
    const result = await produceAnthropic(body, pool, signal, sessionId);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json", "X-M365-Session-ID": sessionId },
    });
  }

  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch {}
      }, 15_000);
      try {
        const result = await produceAnthropic(body, pool, signal, sessionId);
        if (result instanceof Response) {
          let error = { type: "api_error", message: "M365 upstream error" };
          try {
            const payload = await result.json() as any;
            error = {
              type: payload?.error?.type ?? error.type,
              message: payload?.error?.message ?? error.message,
            };
          } catch {}
          controller.enqueue(encoder.encode(event("error", { type: "error", error })));
        } else {
          controller.enqueue(encoder.encode(await anthropicSse(result).text()));
        }
      } catch (error: any) {
        controller.enqueue(encoder.encode(event("error", {
          type: "error",
          error: { type: "api_error", message: error?.message ?? "M365 upstream error" },
        })));
      } finally {
        clearInterval(heartbeat);
        try { controller.close(); } catch {}
      }
    },
  }), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-M365-Session-ID": sessionId,
    },
  });
}

/** Approximation only: M365 exposes no tokenizer compatible with all routed models. */
export function estimateAnthropicInputTokens(value: unknown): number {
  let serialized = "";
  try { serialized = JSON.stringify(value); } catch { serialized = String(value); }
  return Math.max(1, Math.ceil(serialized.length / 4));
}
