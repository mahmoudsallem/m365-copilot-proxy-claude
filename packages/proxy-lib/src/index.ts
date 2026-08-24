import { type ModelSessionOptions, getAvailableModels, resolveModel, isDegradationBackoff, listSystemPrompts, getSystemPrompt } from "@m365-copilot/core";
import { ChatCompletionRequest } from "./schemas.js";
import { SessionPool, handleChatCompletion } from "./handler.js";
import {
  AnthropicMessagesRequest,
  handleAnthropicMessages,
  estimateAnthropicInputTokens,
} from "./anthropic.js";

export { SessionPool, handleChatCompletion } from "./handler.js";
export {
  produceCompletion,
  requestHasTools,
  outputFinishReason,
  buildUsage,
  type Produced,
  type ProduceOptions,
} from "./handler.js";
export { TurnGate, type TurnGateOptions, type TurnGateStats } from "./gate.js";
export { ChatCompletionRequest, ChatMessage, ToolCall, ToolDefinition } from "./schemas.js";
export {
  AnthropicMessagesRequest,
  resolveM365Model,
  toOpenAIChatRequest,
  fromOpenAIChatResponse,
  anthropicSse,
  handleAnthropicMessages,
  estimateAnthropicInputTokens,
  type AnthropicBody,
  type AnthropicMessageResponse,
} from "./anthropic.js";

// Re-export tool utilities from core
export {
  formatMessages,
  formatToolDefinitions,
  parseToolCalls,
  getMessageContent,
  type Message,
  type ToolDef,
  type ToolChoice,
  type ParsedToolCall,
  type ParseResult,
} from "@m365-copilot/core";

// --- Shared response payloads (reused by the Nitro routes in @m365-copilot/proxy) ---

/** Static body for `GET /health`. */
export const HEALTH_PAYLOAD = { status: "ok" } as const;

// Window/output hints surfaced to harnesses on /v1/models so they can size
// context packing and output expectations. These are ADVERTISED hints only — M365
// enforces its own limits server-side; the number here just stops harnesses from
// pre-truncating our prompts/output. Empirically (docs/hypotheses.md F9) M365 accepts
// ≥500k tokens of input (retrieval-backed); the old ~3k output hint made harnesses
// cap generation far below what a coding turn needs. Advertise a roomy 1M window +
// 1M output (in line with modern large-context models) so nothing client-side clips.
// Override via env.
const CONTEXT_WINDOW_TOKENS = Number(process.env.M365_CONTEXT_WINDOW) || 1_000_000;
const MAX_OUTPUT_TOKENS = Number(process.env.M365_MAX_OUTPUT_TOKENS) || 1_000_000;

/** Build the OpenAI-compatible `GET /v1/models` payload. */
export function buildModelsPayload() {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: "list",
    data: getAvailableModels().map((id) => {
      // Capability metadata so harnesses/TUIs can pick intelligently. Unknown keys
      // are ignored by strict clients; resolveModel only throws for unsupported ids.
      let m365: Record<string, unknown> | undefined;
      try {
        const resolved = resolveModel(id);
        m365 = {
          displayName: resolved.config.displayName,
          tone: resolved.config.tone,
          backendFamily: resolved.config.backendFamily,
          supportsAgent: resolved.config.supportsAgent,
          supportsTools: resolved.config.supportsTools,
          toolMode: resolved.config.toolMode,
          canonicalModel: resolved.canonicalModel,
          isAlias: resolved.normalizedModel !== id.toLowerCase() || !!resolved.warnings.length,
          warnings: resolved.warnings,
        };
      } catch { /* leave undefined */ }
      return {
        id,
        object: "model",
        created,
        owned_by: "microsoft",
        // Non-standard but widely-read by OpenAI-compatible harnesses. Several
        // aliases because clients disagree on the key name.
        context_window: CONTEXT_WINDOW_TOKENS,
        max_context_length: CONTEXT_WINDOW_TOKENS,
        max_input_tokens: CONTEXT_WINDOW_TOKENS,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        ...(m365 ? { m365 } : {}),
      };
    }),
  };
}

// --- System prompt library endpoints ---

/** `GET /v1/system-prompts` — metadata for every indexed prompt. */
export function listSystemPromptsPayload() {
  return { object: "list", data: listSystemPrompts() };
}

/** `GET /v1/system-prompts/:name` — the full text of one prompt (404 Response when missing). */
export function getSystemPromptPayload(name: string): { status: number; body: unknown } {
  const text = getSystemPrompt(decodeURIComponent(name));
  if (text == null) {
    return { status: 404, body: { error: { message: `Unknown system prompt "${name}"`, type: "invalid_request_error" } } };
  }
  return { status: 200, body: { name: decodeURIComponent(name), text } };
}

// --- CORS (permissive, matches the previous Hono `cors()` default) ---

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function withCors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A minimal Web fetch handler — the same shape Hono exposed via `app.fetch`. */
export interface FetchApp {
  fetch(req: Request): Promise<Response>;
}

/**
 * Create a framework-free fetch handler that serves an OpenAI-compatible AND
 * Anthropic-compatible API backed by M365 Copilot. Each distinct conversation
 * automatically gets its own M365 session via the SessionPool.
 *
 * This is the embeddable entry point used by the tests, `proxy-verify`, and the
 * openclaw-plugin. The standalone server is the Nitro app in `@m365-copilot/proxy`,
 * whose routes reuse the same helpers.
 */
export function createApp(sessionOptions: ModelSessionOptions = {}): FetchApp {
  const pool = new SessionPool(sessionOptions);

  async function fetch(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    const method = req.method.toUpperCase();

    if (method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    // Per-request opt-in system prompt (header beats env; see core/prompts.ts).
    const systemPromptSpec = req.headers.get("x-m365-system-prompt") ?? undefined;

    if (method === "GET" && pathname === "/health") {
      return withCors(json(200, {
        status: "ok",
        conversations: pool.size,
        gate: pool.turnGate.stats(),
        degradedBackoff: isDegradationBackoff(),
      }));
    }

    if (method === "GET" && pathname === "/v1/models") {
      return withCors(json(200, buildModelsPayload()));
    }

    if (method === "GET" && pathname === "/v1/system-prompts") {
      return withCors(json(200, listSystemPromptsPayload()));
    }

    if (method === "GET" && pathname.startsWith("/v1/system-prompts/")) {
      const name = pathname.slice("/v1/system-prompts/".length);
      const { status, body } = getSystemPromptPayload(name);
      return withCors(json(status, body));
    }

    if (method === "POST" && (pathname === "/v1/chat/completions" || pathname === "/v1/messages" || pathname === "/v1/messages/count_tokens")) {
      let raw: unknown;
      try {
        raw = await req.json();
      } catch (err: any) {
        return withCors(
          json(400, { error: { message: err.message, type: "invalid_request_error" } }),
        );
      }

      // req.signal aborts when the client disconnects → cancels the M365 turn.
      if (pathname === "/v1/messages/count_tokens") {
        return withCors(await handleAnthropicCountTokens(raw));
      }
      if (pathname === "/v1/messages") {
        let body: ReturnType<typeof AnthropicMessagesRequest.parse>;
        try {
          body = AnthropicMessagesRequest.parse(raw);
        } catch (err: any) {
          return withCors(json(400, {
            type: "error",
            error: { type: "invalid_request_error", message: err.message },
          }));
        }
        return withCors(await handleAnthropicMessages(body, pool, { signal: req.signal, systemPrompt: systemPromptSpec }));
      }

      let body: ReturnType<typeof ChatCompletionRequest.parse>;
      try {
        body = ChatCompletionRequest.parse(raw);
      } catch (err: any) {
        return withCors(
          json(400, { error: { message: err.message, type: "invalid_request_error" } }),
        );
      }
      return withCors(await handleChatCompletion(body, pool, { signal: req.signal, systemPromptSpec }));
    }

    return withCors(
      json(404, { error: { message: "Not found", type: "invalid_request_error" } }),
    );
  }

  return { fetch };
}

/** `POST /v1/messages/count_tokens` — cheap local estimate (M365 exposes no tokenizer). */
function handleAnthropicCountTokens(raw: unknown): Response {
  let value: unknown = raw;
  try {
    value = AnthropicMessagesRequest.parse(raw);
  } catch { /* tolerate arbitrary payloads — still estimate */ }
  return json(200, { input_tokens: estimateAnthropicInputTokens(value) });
}
