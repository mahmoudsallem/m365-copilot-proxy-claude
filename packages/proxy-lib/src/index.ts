import {
  type ModelSessionOptions,
  getAvailableModelCapabilities,
} from "@m365-copilot/core";
import { ChatCompletionRequest } from "./schemas.js";
import { SessionPool, handleChatCompletion } from "./handler.js";

export { SessionPool, handleChatCompletion } from "./handler.js";
export { ChatCompletionRequest, ChatMessage, ToolCall, ToolDefinition } from "./schemas.js";
export {
  AnthropicMessagesRequest,
  CLAUDE_GATEWAY_MODEL_PREFIX,
  resolveM365Model,
  toClaudeGatewayModelId,
  toOpenAIChatRequest,
  fromOpenAIChatResponse,
  anthropicSse,
  handleAnthropicMessages,
  estimateAnthropicInputTokens,
  type AnthropicBody,
  type AnthropicMessageResponse,
} from "./anthropic.js";
import { toClaudeGatewayModelId } from "./anthropic.js";

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

/** Build the OpenAI-compatible `GET /v1/models` payload. */
export function buildModelsPayload() {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: "list",
    data: getAvailableModelCapabilities().map((capability) => ({
      id: capability.id,
      object: "model",
      created,
      owned_by: "microsoft",
      // Non-standard but widely-read by OpenAI-compatible harnesses. Several
      // aliases because clients disagree on the key name. Unknown keys are
      // ignored by strict clients.
      context_window: capability.limits.maxInputTokens,
      max_context_length: capability.limits.maxInputTokens,
      max_input_tokens: capability.limits.maxInputTokens,
      max_output_tokens: capability.limits.maxOutputTokens,
      x_m365_tone: capability.tone,
      x_m365_certification: capability.certification,
      x_m365_identity_confidence: capability.identity.confidence,
      x_m365_tool_route: capability.route.tools,
      x_m365_tool_reliability: capability.toolReliability,
      x_m365_auto_selectable: capability.autoSelectable,
      x_m365_last_tested_service: capability.lastTestedServiceVersion,
    })),
  };
}

/** Build Anthropic's Models API shape for Claude Code gateway discovery. */
export function buildClaudeGatewayModelsPayload() {
  const createdAt = "1970-01-01T00:00:00Z";
  const data = getAvailableModelCapabilities().map((capability) => ({
    id: toClaudeGatewayModelId(capability.id),
    type: "model" as const,
    display_name: `${capability.id} [${capability.certification}]`,
    created_at: createdAt,
    max_input_tokens: capability.limits.maxInputTokens,
    max_tokens: capability.limits.maxOutputTokens,
    x_m365_tone: capability.tone,
    x_m365_certification: capability.certification,
    x_m365_identity_confidence: capability.identity.confidence,
    x_m365_tool_route: capability.route.tools,
    x_m365_auto_selectable: capability.autoSelectable,
  }));
  return {
    data,
    first_id: data[0]?.id ?? null,
    has_more: false,
    last_id: data.at(-1)?.id ?? null,
  };
}

// --- CORS (permissive, matches the previous Hono `cors()` default) ---

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-M365-Claude-Code, X-M365-Session-ID",
  "Access-Control-Expose-Headers": "X-M365-Session-ID",
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
 * Create a framework-free fetch handler that serves an OpenAI-compatible API
 * backed by M365 Copilot. Each distinct conversation automatically gets its own
 * M365 session via the SessionPool.
 *
 * This is the embeddable entry point used by the tests, `proxy-verify`, and the
 * openclaw-plugin. The standalone server is the Nitro app in `@m365-copilot/proxy`,
 * whose routes reuse the same `handleChatCompletion` / `buildModelsPayload` helpers.
 */
export function createApp(sessionOptions: ModelSessionOptions = {}): FetchApp {
  const pool = new SessionPool(sessionOptions);

  async function fetch(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    const method = req.method.toUpperCase();

    if (method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    if (method === "GET" && pathname === "/health") {
      return withCors(json(200, HEALTH_PAYLOAD));
    }

    if (method === "GET" && pathname === "/v1/models") {
      const isClaudeCode = req.headers.get("x-m365-claude-code") === "1";
      return withCors(json(200, isClaudeCode
        ? buildClaudeGatewayModelsPayload()
        : buildModelsPayload()));
    }

    if (method === "POST" && pathname === "/v1/chat/completions") {
      let body: ReturnType<typeof ChatCompletionRequest.parse>;
      try {
        body = ChatCompletionRequest.parse(await req.json());
      } catch (err: any) {
        return withCors(
          json(400, { error: { message: err.message, type: "invalid_request_error" } }),
        );
      }
      // req.signal aborts when the client disconnects → cancels the M365 turn.
      return withCors(await handleChatCompletion(body, pool, {
        signal: req.signal,
        sessionId: req.headers.get("x-m365-session-id") ?? undefined,
      }));
    }

    return withCors(
      json(404, { error: { message: "Not found", type: "invalid_request_error" } }),
    );
  }

  return { fetch };
}
