import { type ModelSessionOptions, getAvailableModels, resolveModel, isDegradationBackoff, listSystemPrompts, getSystemPrompt } from "@m365-copilot/core";
import { ChatCompletionRequest } from "./schemas.js";
import { SessionPool, handleChatCompletion, getTurnStats } from "./handler.js";
import { toneHealth } from "./health.js";
import { modelPromptEnabled, modelPromptCandidates, resolveModelSystemPrompt } from "./model-prompts.js";
import {
  AnthropicMessagesRequest,
  handleAnthropicMessages,
  estimateAnthropicInputTokens,
} from "./anthropic.js";

export { SessionPool, handleChatCompletion, getTurnStats } from "./handler.js";
export {
  classifyFailure,
  toneHealth,
  nextHealthyFallback,
  fallbackChain,
  failoverEnabled,
  type FailureClass,
  type BreakerStatus,
} from "./health.js";
export {
  upstreamEnabled,
  upstreamConfig,
  mapUpstreamModel,
  handleUpstreamChat,
  handleUpstreamMessages,
} from "./upstream.js";
export {
  modelPromptEnabled,
  modelPromptCandidates,
  resolveModelSystemPrompt,
  type RoutedModelPrompt,
} from "./model-prompts.js";
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

/**
 * `GET /v1/model-prompts` — the model→prompt route table with live resolution
 * status for every advertised model (which corpus prompt each WOULD inject).
 */
export function modelPromptRoutesPayload() {
  return {
    enabled: modelPromptEnabled(),
    routes: getAvailableModels().map((id) => {
      const candidates = modelPromptCandidates(id);
      let routed: { name: string; chars: number; truncated: boolean } | null = null;
      try {
        const hit = resolveModelSystemPrompt(id);
        if (hit) routed = { name: hit.name, chars: hit.text.length, truncated: hit.truncated };
      } catch { /* corpus absent — leave unrouted */ }
      return { model: id, candidates, ...(routed ? { routed } : {}) };
    }),
  };
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
    // Caller conversation identity: distinct keys never share an M365 thread.
    const sessionKey = req.headers.get("x-m365-session-id") ?? undefined;

    if (method === "GET" && pathname === "/health") {
      return withCors(json(200, {
        status: "ok",
        conversations: pool.size,
        gate: pool.turnGate.stats(),
        degradedBackoff: isDegradationBackoff(),
      }));
    }

    // --- Ops status page (local UI): tone breakers + recent turn latencies. ---
    if (method === "GET" && pathname === "/" || method === "GET" && pathname === "/status") {
      const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>m365-copilot-proxy status</title>
<meta http-equiv="refresh" content="5">
<style>
  body{font-family:ui-monospace,Consolas,monospace;background:#0b0e14;color:#d7dce6;margin:24px}
  h1{font-size:18px} h2{font-size:14px;color:#8ab4ff;margin:18px 0 6px}
  table{border-collapse:collapse;font-size:12px}
  td,th{border:1px solid #2a3040;padding:3px 10px;text-align:left}
  th{color:#9aa4b8;font-weight:600}
  .ok{color:#7ee787}.warn{color:#e3b341}.bad{color:#ff7b72}.muted{color:#8b949e}
  small{color:#8b949e}
</style></head><body>
<h1>m365-copilot-proxy <small>· auto-refresh 5s · <a style="color:#8ab4ff" href="/health">/health</a> <a style="color:#8ab4ff" href="/v1/models">/v1/models</a></small></h1>
<h2>Tone health (circuit breakers)</h2><div id="tones">…</div>
<h2>Recent upstream turns</h2><div id="turns">…</div>
<script>
async function j(u){return (await fetch(u)).json()}
function esc(s){return String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]))}
(async()=>{
  try{
    const [h,s]=await Promise.all([j("/health"),j("/internal/stats")]);
    const badge=(st)=>st==="closed"?"<span class='ok'>closed</span>":st==="half_open"?"<span class='warn'>half-open</span>":"<span class='bad'>OPEN</span>";
    document.getElementById("tones").innerHTML =
      "<table><tr><th>model</th><th>breaker</th><th>consecutive failures</th></tr>"+
      (s.tones.length?s.tones.map(t=>"<tr><td>"+esc(t.model)+"</td><td>"+badge(t.status)+"</td><td>"+t.consecutiveFailures+"</td></tr>").join(""):"<tr><td colspan='3' class='muted'>no failures recorded — all tones healthy</td></tr>")+"</table>"+
      "<p><small>conversations: "+h.conversations+" · gate: "+JSON.stringify(h.gate)+" · degradedBackoff: "+h.degradedBackoff+"</small></p>";
    const cls=(o)=>o==="ok"?"<span class='ok'>ok</span>":o==="disengaged"?"<span class='warn'>disengaged</span>":o==="rate_limited"?"<span class='warn'>limited</span>":"<span class='bad'>empty</span>";
    document.getElementById("turns").innerHTML =
      "<table><tr><th>when</th><th>model</th><th>total</th><th>ttft</th><th>chars</th><th>outcome</th></tr>"+
      s.turns.slice().reverse().map(t=>"<tr><td class='muted'>"+new Date(t.at).toLocaleTimeString()+"</td><td>"+esc(t.model)+"</td><td>"+t.totalMs+"ms</td><td>"+(t.ttftMs==null?"—":t.ttftMs+"ms")+"</td><td>"+t.chars+"</td><td>"+cls(t.outcome)+"</td></tr>").join("")+"</table>";
  }catch(e){document.body.insertAdjacentHTML("beforeend","<pre class='bad'>"+esc(e.message)+"</pre>")}
})();
</script></body></html>`;
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (method === "GET" && pathname === "/internal/stats") {
      return withCors(json(200, {
        tones: toneHealth.snapshot(),
        turns: getTurnStats(),
      }));
    }

    if (method === "GET" && pathname === "/v1/models") {
      return withCors(json(200, buildModelsPayload()));
    }

    if (method === "GET" && pathname === "/v1/system-prompts") {
      return withCors(json(200, listSystemPromptsPayload()));
    }

    if (method === "GET" && pathname === "/v1/model-prompts") {
      return withCors(json(200, modelPromptRoutesPayload()));
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
        return withCors(await handleAnthropicMessages(body, pool, { signal: req.signal, systemPrompt: systemPromptSpec, sessionKey }));
      }

      let body: ReturnType<typeof ChatCompletionRequest.parse>;
      try {
        body = ChatCompletionRequest.parse(raw);
      } catch (err: any) {
        return withCors(
          json(400, { error: { message: err.message, type: "invalid_request_error" } }),
        );
      }
      return withCors(await handleChatCompletion(body, pool, { signal: req.signal, systemPromptSpec, sessionKey }));
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
