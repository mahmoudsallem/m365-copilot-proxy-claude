import {
  ModelSession,
  type ModelSessionOptions,
  createLogger,
  trunc,
  getToneForModel,
  resolveModel,
  UnsupportedModelError,
  formatMessages,
  parseToolCalls,
  looksLikeConfabulation,
  looksLikeHallucinatedCompletion,
  isProseDocument,
  getMessageContent,
  noteRequestOutcome,
  awaitDegradationBackoff,
  getImageArtifactToken,
  fetchImageBytes,
  type CapturedImage,
} from "@m365-copilot/core";
import { ChatCompletionRequest } from "./schemas.js";
import type { z } from "zod/v4";

const log = createLogger("handler");

// Render generated images (§14) as markdown so any OpenAI-compatible client shows
// them inline. The artifact URL 401s without the designerappservice token, so we
// fetch the bytes ourselves and embed a self-contained data URI — a bare URL would
// be useless to the client. On fetch failure we fall back to the raw URL so the
// response is never silently empty.
async function renderImagesMarkdown(images: CapturedImage[]): Promise<string> {
  if (images.length === 0) return "";
  let artifactToken: string | null = null;
  try { artifactToken = await getImageArtifactToken(); } catch (e: any) { log.info(`image token failed: ${e.message}`); }
  const parts: string[] = [];
  for (const img of images) {
    const url = img.referenceUrls[0];
    if (!url) continue;
    if (artifactToken) {
      try {
        const { data, contentType } = await fetchImageBytes(url, artifactToken);
        parts.push(`![generated image](data:${contentType};base64,${data.toString("base64")})`);
        continue;
      } catch (e: any) { log.info(`image fetch failed: ${e.message}`); }
    }
    parts.push(`![generated image](${url})`);
  }
  return parts.join("\n\n");
}

// Forcing follow-up sent (in the same conversation) when M365 confabulates an
// inability to act instead of calling a tool. See the confab-retry loop below.
const CONFAB_FORCE_PROMPT =
  "The working directory and the files named in the task ARE present on a real filesystem right now. Do NOT ask me to paste anything, and do NOT say commands return no output — you have not run any command yet. Emit ONE ```bash block this turn: run `ls -la` and `cat` the relevant files. Output only the ```bash block, nothing else.";

// Forcing follow-up when the model CLAIMS it did a file change but ran no tool.
const HALLUCINATION_FORCE_PROMPT =
  "You have NOT actually done that — no tool ran this turn, so nothing changed on disk. Do not claim a file was created, replaced, or updated until a <tool_response> confirms it. Emit ONE ```bash block now that performs the change for real (write the file with a `cat > path <<'EOF' … EOF` heredoc), and nothing else.";

// M365 soft-caps output around ~3k tokens (~12k chars) and — critically —
// CONCLUDES EARLY rather than truncating mid-stream, so a too-long answer comes
// back clean-looking but incomplete with no error to detect (docs/hypotheses.md
// F9). We can't see token counts, so we heuristically flag responses at/over the
// observed ceiling with finish_reason:"length" — the standard signal a harness
// uses to ask for a continuation. Tune/disable via env (0 disables).
const OUTPUT_CHAR_CEILING = process.env.M365_OUTPUT_CHAR_CEILING !== undefined
  ? Number(process.env.M365_OUTPUT_CHAR_CEILING)
  : 12_000;

/** "length" when the answer is at/over the empirical output ceiling, else "stop". */
function outputFinishReason(text: string): "stop" | "length" {
  if (OUTPUT_CHAR_CEILING > 0 && text.length >= OUTPUT_CHAR_CEILING) {
    log.info(`Output at ceiling (${text.length} ≥ ${OUTPUT_CHAR_CEILING} chars) — finish_reason=length (likely truncated; harness should continue)`);
    return "length";
  }
  return "stop";
}

type ChatBody = z.infer<typeof ChatCompletionRequest>;
type ParsedMessage = ChatBody["messages"][number];

/**
 * Turn a first-turn false refusal into one harmless, real local action without
 * spending another M365 message asking the model to reconsider.  The client
 * executes this call, then sends its output back through the normal agent loop.
 * Keep this deliberately read-only and only use the caller's actual shell tool.
 */
const LIST_TOOL_NAME = /^(ls|list|list_dir|list_directory|glob|dir|find_files|search_files|ls_dir|view_dir)$/i;

export function makeOrientationToolCall(body: ChatBody): ReturnType<typeof parseToolCalls>["toolCalls"][number] | null {
  if (!Array.isArray(body.tools) || body.tools.length === 0) return null;

  const shell = findShellTool(body.tools);
  if (shell) {
    if (typeof body.tool_choice === "object") {
      const selected = body.tool_choice.function.name;
      const selectedTool = body.tools.find((tool) => tool.function.name === selected);
      if (selectedTool !== shell && !isShellToolName(selected)) return null;
    }

    const commandParam = shellCommandParam(shell);
    if (commandParam) {
      return {
        id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
        type: "function",
        function: {
          name: shell.function.name,
          arguments: JSON.stringify({ [commandParam]: "pwd && ls -la" }),
        },
      };
    }
  }

  const listTool = body.tools.find((t) => LIST_TOOL_NAME.test(t.function.name));
  if (listTool) {
    const props = Object.keys(listTool.function.parameters?.properties ?? {});
    const pathArg = props.find((p) => /^(path|dir|directory|pattern|glob)$/i.test(p)) ?? props[0];
    const val = /pattern|glob/i.test(pathArg ?? "") ? "*" : ".";
    return {
      id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
      type: "function",
      function: {
        name: listTool.function.name,
        arguments: pathArg ? JSON.stringify({ [pathArg]: val }) : "{}",
      },
    };
  }

  const firstTool = body.tools[0];
  return {
    id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "function",
    function: {
      name: firstTool.function.name,
      arguments: "{}",
    },
  };
}

const SHELL_TOOL_NAME = /^(bash|sh|shell|zsh|run|exec|execute|command|cmd|terminal|run_command|run_terminal_cmd|execute_command|execute_bash|shell_exec|system)$/i;
const SHELL_COMMAND_PARAMS = ["command", "cmd", "script", "input"];

function isShellToolName(name: string): boolean {
  return SHELL_TOOL_NAME.test(name);
}

function findShellTool(tools: NonNullable<ChatBody["tools"]>): NonNullable<ChatBody["tools"]>[number] | null {
  return tools.find((tool) => isShellToolName(tool.function.name)) ??
    tools.find((tool) => {
      const props = Object.keys(tool.function.parameters?.properties ?? {});
      return props.length === 1 && SHELL_COMMAND_PARAMS.some((p) => p.toLowerCase() === props[0].toLowerCase());
    }) ??
    null;
}

function shellCommandParam(tool: NonNullable<ChatBody["tools"]>[number]): string | null {
  const props = Object.keys(tool.function.parameters?.properties ?? {});
  return SHELL_COMMAND_PARAMS.find((p) => props.includes(p)) ??
    props.find((p) => SHELL_COMMAND_PARAMS.some((known) => known.toLowerCase() === p.toLowerCase())) ??
    (props.length === 1 ? props[0] : null);
}

// --- Per-conversation state ---

interface ConversationState {
  session: ModelSession;
  sentMessageCount: number;
  lastAccessedAt: number;
}

// --- Session pool: maps conversation fingerprint → M365 session ---

const MAX_IDLE_MS = 30 * 60 * 1000; // evict after 30 min idle

export class SessionPool {
  private conversations = new Map<string, ConversationState>();
  private sessionOptions: ModelSessionOptions;

  constructor(sessionOptions: ModelSessionOptions = {}) {
    this.sessionOptions = sessionOptions;
  }

  /**
   * Resolve the conversation state for an incoming request.
   * Fingerprint is the hash of the first user message — same first user message = same conversation.
   */
  resolve(messages: ParsedMessage[]): ConversationState {
    this.evictStale();

    const fingerprint = this.fingerprint(messages);
    const existing = this.conversations.get(fingerprint);

    if (existing) {
      // Messages shrunk means client restarted this conversation — reset M365 session
      if (messages.length < existing.sentMessageCount) {
        log.info(`Conversation ${fingerprint}: messages shrunk (${messages.length} < ${existing.sentMessageCount}), resetting`);
        existing.session.reset();
        existing.sentMessageCount = 0;
      }
      existing.lastAccessedAt = Date.now();
      return existing;
    }

    // New conversation
    log.info(`New conversation ${fingerprint}, ${this.conversations.size} active`);
    const state: ConversationState = {
      session: new ModelSession(this.sessionOptions),
      sentMessageCount: 0,
      lastAccessedAt: Date.now(),
    };
    this.conversations.set(fingerprint, state);
    return state;
  }

  private fingerprint(messages: ParsedMessage[]): string {
    const firstUser = messages.find(m => m.role === "user");
    const text = firstUser ? getMessageContent(firstUser) : "";
    return simpleHash(text);
  }

  private evictStale() {
    const now = Date.now();
    for (const [key, state] of this.conversations) {
      if (now - state.lastAccessedAt > MAX_IDLE_MS) {
        log.info(`Evicting idle conversation ${key}`);
        this.conversations.delete(key);
      }
    }
  }

  get size(): number {
    return this.conversations.size;
  }
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return String(hash);
}

// --- Delta message formatting ---

function formatDeltaMessages(messages: ParsedMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      // Skip assistant messages — M365 already has them server-side.
      // Echoing them back as a user message confuses M365.
      continue;
    } else if (m.role === "tool") {
      const name = m.name || "unknown";
      const callId = m.tool_call_id || "?";
      parts.push(`<tool_response name="${name}" call_id="${callId}">\n${getMessageContent(m)}\n</tool_response>`);
    } else if (m.role === "system") {
      // Skip system messages on follow-up turns
    } else {
      parts.push(`<${m.role}>\n${getMessageContent(m)}\n</${m.role}>`);
    }
  }
  return parts.join("\n\n");
}

// --- Main handler ---

/**
 * Handle a chat completion request, returning an OpenAI-compatible Response.
 * The SessionPool routes each conversation to its own ModelSession.
 */
export async function handleChatCompletion(
  body: ChatBody,
  pool: SessionPool,
  opts: { signal?: AbortSignal } = {},
): Promise<Response> {
  let resolved;
  try {
    resolved = resolveModel(body.model);
  } catch (err: any) {
    if (err instanceof UnsupportedModelError) {
      return jsonResponse(400, {
        error: {
          message: err.message,
          type: "invalid_request_error",
          code: "UNSUPPORTED_MODEL",
          supported_models: err.supportedModels,
        },
      });
    }
    return jsonResponse(400, { error: { message: err.message, type: "invalid_request_error" } });
  }

  // Log warnings for deprecated/preset model aliases
  if (resolved.warnings.length > 0) {
    for (const warn of resolved.warnings) {
      log.warn(`Model resolution warning: ${warn}`);
    }
  }

  const conv = pool.resolve(body.messages);
  const { session } = conv;
  const hasTools = body.tools && body.tools.length > 0 && body.tool_choice !== "none";
  const model = resolved.canonicalModel;

  const tone = resolved.config.tone;
  const isClaudeTone = /^Claude_/i.test(tone);
  const useToolAgent = !!hasTools && resolved.config.supportsAgent && (process.env.M365_FORCE_AGENT === "1" || !isClaudeTone);

  // Format message: full prompt on first turn, delta on follow-ups.
  // M365 is stateful — it remembers everything from prior turns,
  // so we only need to send new messages after the first turn.
  const isFirstTurn = session.turnCount === 0;
  const convId = session.conversationId;
  let text: string;
  if (isFirstTurn || conv.sentMessageCount === 0) {
    text = formatMessages(body.messages, body.tools, body.tool_choice, convId);
    log.info(`Chat completion: model=${model}, stream=${body.stream}, messages=${body.messages.length}, turn=${session.turnCount}, mode=full, cid=${convId}`);
  } else {
    const newMessages = body.messages.slice(conv.sentMessageCount);
    const delta = newMessages.length > 0 ? formatDeltaMessages(newMessages) : "";
    if (delta.length > 0) {
      text = delta;
      log.info(`Chat completion: model=${model}, stream=${body.stream}, messages=${body.messages.length}, new=${newMessages.length}, turn=${session.turnCount}, mode=delta, cid=${convId}`);
    } else {
      // No meaningful new content to send — nudge M365 to continue.
      text = "Please continue.";
      log.info(`Chat completion: model=${model}, stream=${body.stream}, messages=${body.messages.length}, turn=${session.turnCount}, mode=retry, cid=${convId}`);
    }
  }

  log.debug("Formatted prompt:", trunc(text, 1000));

  const completionId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  // Buffer the full response, with a couple of quick retries on an empty reply.
  const MAX_RETRIES = 2;
  const SHORT_RETRY_DELAY_MS = 2_000;

  // Captured from the final attempt — surfaced through the OpenAI `usage` block
  // so clients can see M365's conversation-quota % (the closest proxy we have
  // to "context window remaining"). Token counts aren't exposed by M365.
  let lastThrottle: { current: number; max: number } | null = null;
  let lastContentOrigin: string | null | undefined;
  let lastMessageType: string | null | undefined;
  let lastScores: Record<string, number> | null | undefined;
  let lastTurnCount: number | null | undefined;

  // `onDelta` (when provided) forwards each text delta to the caller AS IT ARRIVES,
  // for live incremental streaming. It's safe to forward without ever retracting:
  // runBuffered only retries on an EMPTY attempt (Disengaged, dead-agent, throttle),
  // and an empty attempt emits no deltas — so a forwarded delta always belongs to the
  // one attempt that produced content and is never re-sent by a subsequent retry.
  async function runBuffered(
    onDelta?: (delta: string) => void,
  ): Promise<{ fullText: string } | { error: Response }> {
    let agentRefreshed = false;
    let disengageRetried = false;
    const originalText = text;
    // Self-imposed pacing while the account is degraded (thread-rate throttle). A
    // no-op when healthy; during backoff it sleeps a jittered delay so we stop
    // starting fresh turns into the throttle and let it self-heal (H-R1). This
    // replaced the old auto-reauth, which didn't clear the throttle and raised our
    // detection profile. A single long pi thread never trips the trigger.
    await awaitDegradationBackoff();
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const startTime = performance.now();
      let firstTokenTime: number | null = null;
      let copilotStream;
      try {
        copilotStream = await session.run(text, model, opts.signal, useToolAgent);
      } catch (err: any) {
        return { error: jsonResponse(502, { error: { message: err.message, type: "upstream_error" } }) };
      }

      let fullText = "";
      try {
        for await (const delta of copilotStream) {
          if (firstTokenTime === null && delta.length > 0) {
            firstTokenTime = performance.now();
          }
          fullText += delta;
          onDelta?.(delta);
        }
        if (copilotStream.fullText && copilotStream.fullText.length > fullText.length) {
          fullText = copilotStream.fullText;
        }
      } catch (err: any) {
        return { error: jsonResponse(502, { error: { message: err.message, type: "upstream_error" } }) };
      }

      const totalTime = Math.round(performance.now() - startTime);
      const ttft = firstTokenTime ? Math.round(firstTokenTime - startTime) : null;
      log.info(`Upstream turn latency: total=${totalTime}ms, ttft=${ttft ?? "N/A"}ms, chars=${fullText.length}, model=${model}`);

      // Image gen (§14): the picture arrives on a GraphicArt frame, usually with NO
      // chat text — so an image turn looks empty to the checks below and would burn
      // a retry. Render the image(s) into the response instead, and (for streaming)
      // emit the markdown as a trailing delta so the client isn't left with nothing.
      const images = copilotStream.images ?? [];
      if (images.length > 0) {
        const imageMd = await renderImagesMarkdown(images);
        if (imageMd) {
          const addition = fullText.length > 0 ? `\n\n${imageMd}` : imageMd;
          fullText += addition;
          onDelta?.(addition);   // stream the appended markdown (text deltas already sent)
        }
      }

      lastThrottle = copilotStream.throttle;
      lastContentOrigin = copilotStream.contentOrigin;
      lastMessageType = copilotStream.messageType;
      lastScores = copilotStream.scores;
      lastTurnCount = copilotStream.turnCount;

      if (copilotStream.hasContent || fullText.length > 0) {
        noteRequestOutcome(false, convId); // clean response → degradation has lifted
        return { fullText };
      }

      // Disengaged is a deliberate safety refusal, NOT a transient empty. Retrying
      // it with "Please continue." just disengages again and burns the 600-msg
      // quota (observed: 5 wasted messages in one turn). Fail fast with a clear
      // signal instead. Commonly fires when a heavy tool prompt is paired with a
      // non-default model/agent (e.g. a Claude tone + the declarative agent).
      if (copilotStream.messageType === "Disengaged") {
        // F22: the default framing's override-shape language occasionally trips Azure
        // Prompt Shields (jailbreak classifier) on benign requests (e.g. "replace X
        // with Y, leave everything else unchanged"). Retry ONCE with the low-override
        // `softened` framing in a FRESH conversation (a Disengaged conversation stays
        // Disengaged). Drops the worst-case disengage ~100%→~4%. Off via
        // M365_NO_DISENGAGE_RETRY.
        if (hasTools && !disengageRetried && !process.env.M365_NO_DISENGAGE_RETRY) {
          disengageRetried = true;
          session.newConversation();
          text = formatMessages(body.messages, body.tools, body.tool_choice, session.conversationId, "softened");
          log.info("Upstream Disengaged — retrying once with 'softened' framing in a fresh conversation (F22)");
          attempt--; // free retry; bounded — disengageRetried flips once
          continue;
        }
        log.info("Upstream Disengaged — failing fast (no retry) to preserve quota");
        return {
          error: jsonResponse(502, {
            error: {
              message: "M365 Copilot disengaged from this request (its safety filter declined to answer). Common causes: too many tools, jailbreak-shaped instructions, or pairing a non-default model with the tool agent. Reduce the toolset or use the default model.",
              type: "disengaged",
            },
          }),
        };
      }

      // Empty response. Only an at-limit throttle warrants treating this as rate
      // limiting; otherwise it's a different failure (content filter, an invalid
      // agent/session, a transient upstream error) where a long escalating
      // backoff is futile and reads as a silent hang. Fail fast after a couple of
      // quick retries instead.
      const t = copilotStream.throttle;
      if (t && t.current >= t.max) {
        return { error: rateLimitResponse(t) };
      }
      if (attempt < MAX_RETRIES) {
        // A dead/deleted agent returns an instant empty reply (throttle: null).
        // Re-resolve the agent once before retrying so a long-lived host
        // self-heals from the deleted-agent trap instead of looping on empties.
        if (!agentRefreshed) {
          agentRefreshed = true;
          const agentChanged = await session.refreshAgent();
          if (agentChanged) {
            // The cached agent was stale/deleted and has been re-resolved.
            // Resend the original prompt to the fresh agent — a bare "continue"
            // would have no context since the dead agent processed nothing.
            log.info("Agent re-resolved after empty reply, resending original prompt");
            text = originalText;
            await new Promise(r => setTimeout(r, SHORT_RETRY_DELAY_MS));
            continue;
          }
        }
        log.info(`Empty upstream response, quick retry in ${SHORT_RETRY_DELAY_MS / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, SHORT_RETRY_DELAY_MS));
        text = "Please continue."; // M365 already has context
      } else {
        // Final empty after retries, and not an at-limit (per-conversation) cap:
        // this is the thread-rate throttle signature (F13). Feed the degradation-
        // backoff policy — once empties span enough distinct conversations it paces
        // subsequent turns so the account can self-heal (H-R1). Never blocks this request.
        noteRequestOutcome(true, convId);
        return { error: emptyResponseResponse(t) };
      }
    }
    noteRequestOutcome(true, convId);
    return { error: emptyResponseResponse(null) };
  }

  // Produce the final turn result as DATA (not a Response), so the same logic
  // renders as either JSON (non-stream) or an early-flushed SSE stream (stream).
  // For streaming we return the SSE stream FIRST and run produce() INSIDE it, so the
  // client gets HTTP 200 + a role chunk + heartbeats immediately instead of waiting
  // out the whole (up to ~160s) M365 turn and risking a read-timeout.
  type Produced =
    | { kind: "error"; resp: Response }
    | { kind: "text"; text: string }
    | { kind: "tools"; toolCalls: ReturnType<typeof parseToolCalls>["toolCalls"] };

  // `onDelta` streams text to the client live (non-tool path only — see produce's
  // caller). Tool mode ignores it: the raw text is parsed for tool-call fences and
  // can't be shown verbatim, so it stays fully buffered.
  async function produce(onDelta?: (delta: string) => void): Promise<Produced> {
  // When tools are present, buffer full response to detect tool calls
  if (hasTools) {
    const result = await runBuffered();
    if ("error" in result) return { kind: "error", resp: result.error };
    conv.sentMessageCount = body.messages.length;
    let fullText = result.fullText;

    log.debug("Raw response (tool mode):", trunc(fullText, 1000));
    let parsed = parseToolCalls(fullText, body.tools);
    log.info(`Parse result: hasToolCalls=${parsed.hasToolCalls}, count=${parsed.toolCalls.length}`);

    // Salvage stochastic turn-1 confabulation: M365's chat model sometimes claims it
    // "can't access the files / commands return no output" and asks the user to paste
    // them, WITHOUT calling a tool — even though the environment is real (the bench +
    // pi both reproduce this). Re-prompt forcefully in the SAME conversation (one
    // thread, cheap). Disable with M365_NO_CONFAB_RETRY; tune count with M365_CONFAB_RETRIES.
    const maxConfabRetries = process.env.M365_NO_CONFAB_RETRY
      ? 0
      : Number(process.env.M365_CONFAB_RETRIES ?? 1);
    // The model never actually acted if no assistant turn in the history carried a
    // tool call. Used to gate the hallucinated-completion retry (a model that did
    // real work called at least one tool), keeping false positives near zero.
    const everActed = (body.messages ?? []).some(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
    );
    for (let attempt = 0; attempt < maxConfabRetries && !parsed.hasToolCalls; attempt++) {
      const confab = looksLikeConfabulation(parsed.textContent);
      const halluc = !everActed && looksLikeHallucinatedCompletion(parsed.textContent);
      if (!confab && !halluc) break;

      // On a first-turn false refusal, do not spend another scarce M365 message
      // merely telling the model that the filesystem exists. Return a safe local
      // orientation call instead. Once its real output comes back, the next turn
      // has concrete evidence and the model can continue the original task.
      if (confab) {
        const orientationCall = makeOrientationToolCall(body);
        if (orientationCall) {
          log.info("Confabulation detected — returning a read-only orientation tool call");
          parsed = { hasToolCalls: true, toolCalls: [orientationCall], textContent: null };
          break;
        }
      }

      log.info(`${confab ? "Confabulation" : "Hallucinated completion"} detected (no tool call) — forcing retry ${attempt + 1}/${maxConfabRetries}`);
      text = confab ? CONFAB_FORCE_PROMPT : HALLUCINATION_FORCE_PROMPT;
      const retry = await runBuffered();
      if ("error" in retry) return { kind: "error", resp: retry.error };
      conv.sentMessageCount = body.messages.length;
      fullText = retry.fullText;
      parsed = parseToolCalls(fullText, body.tools);
      log.info(`After forcing retry: hasToolCalls=${parsed.hasToolCalls}, count=${parsed.toolCalls.length}`);
    }

    // Document guard: the shell-routing parser turns every ```bash block into a
    // tool call, so a model that ANSWERS with a markdown document full of code
    // fences (e.g. "here's a simplified README") would get its own answer executed
    // as shell. Detect that shape (multiple fences + prose) and return the document
    // as plain text instead of running it. See isProseDocument (chosen empirically).
    if (isProseDocument(parsed)) {
      log.info(`Response is a prose document (${parsed.toolCalls.length} embedded fences), returning as text instead of executing`);
      parsed = { hasToolCalls: false, toolCalls: [], textContent: fullText };
    }

    // Fail-closed: if model mixed text with tool calls, strip text and re-prompt once.
    // This enforces the "output ONLY a tool call" contract.
    if (parsed.hasToolCalls && parsed.textContent) {
      const extraText = parsed.textContent.trim();
      if (extraText.length > 0) {
        log.info(`Mixed output detected (${extraText.length} chars of text alongside ${parsed.toolCalls.length} tool calls), stripping text`);
        // Strip the text — the tool calls are what the client needs.
        // Log the stripped text for debugging but don't send it downstream.
        log.debug("Stripped text:", trunc(extraText, 500));
        parsed = { ...parsed, textContent: null };
      }
    }

    // Handle "reply" tool calls — convert to plain text
    if (parsed.hasToolCalls) {
      const replyCall = parsed.toolCalls.find(tc => tc.function.name === "reply");
      const realToolCalls = parsed.toolCalls.filter(tc => tc.function.name !== "reply");

      if (replyCall && realToolCalls.length === 0) {
        let replyText: string;
        try {
          const args = JSON.parse(replyCall.function.arguments);
          replyText = args.text || args.message || args.content || fullText;
        } catch {
          replyText = fullText;
        }
        log.info("Reply tool detected, converting to text response");
        return { kind: "text", text: replyText };
      }

      if (realToolCalls.length > 0) {
        parsed.toolCalls = realToolCalls;
      }

      // Enforce one tool call per turn unless explicitly opted out. M365 — the
      // reasoning tones especially — batches its whole plan into a single
      // response. Executing a batch runs later steps on guessed state and lets a
      // premature success claim ride along at the end. Keeping only the first
      // call forces a real step-by-step loop where each call reacts to the
      // previous tool_response. Set M365_ALLOW_MULTI_TOOL to restore batching.
      if (!process.env.M365_ALLOW_MULTI_TOOL && parsed.toolCalls.length > 1) {
        log.info(`One-call-per-turn: keeping ${parsed.toolCalls[0].function.name}, dropping ${parsed.toolCalls.length - 1} batched call(s)`);
        parsed.toolCalls = [parsed.toolCalls[0]];
      }
    }

    if (parsed.hasToolCalls && parsed.toolCalls.length > 0) {
      return { kind: "tools", toolCalls: parsed.toolCalls };
    }
    return { kind: "text", text: fullText.trim() || "Okay." };
  } else {
    // No tools — stream deltas live (onDelta) while buffering for the retry logic.
    const result = await runBuffered(onDelta);
    if ("error" in result) return { kind: "error", resp: result.error };
    conv.sentMessageCount = body.messages.length;
    return { kind: "text", text: result.fullText.trim() || "Okay." };
  }
  } // end produce()

  // --- Render: JSON (non-stream) or an early-flushed SSE stream (stream) ---
  const includeUsage = !!body.stream_options?.include_usage;
  const usage = () => buildUsage(lastThrottle, lastContentOrigin, lastMessageType, lastScores, lastTurnCount);

  if (!body.stream) {
    let p: Produced;
    try {
      p = await produce();
    } catch (err: any) {
      console.error("[produce error non-stream]", err.stack || err);
      return jsonResponse(502, { error: { message: err?.message ?? "upstream error", type: "upstream_error" } });
    }
    if (p.kind === "error") return p.resp;
    if (p.kind === "tools") {
      return jsonResponse(200, {
        id: completionId, object: "chat.completion", created, model,
        choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: p.toolCalls }, finish_reason: "tool_calls" }],
        usage: usage(),
      });
    }
    return jsonResponse(200, {
      id: completionId, object: "chat.completion", created, model,
      choices: [{ index: 0, message: { role: "assistant", content: p.text }, finish_reason: outputFinishReason(p.text) }],
      usage: usage(),
    });
  }

  // Streaming: send HTTP 200 + a role chunk + keepalive comments from t=0, then run
  // produce() INSIDE the stream so the client never waits out the whole M365 turn
  // (up to ~160s) before the first byte — avoids client read-timeouts.
  //
  // On the non-tool path we forward each text delta AS IT ARRIVES (`liveDelta`), so
  // `stream:true` is genuinely incremental. Tool mode still buffers: the raw text is
  // parsed for tool-call fences and can't be shown verbatim, so its tool_calls (or a
  // prose fallback) are emitted once at the end.
  return sseResponse(new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (obj: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const base = { id: completionId, object: "chat.completion.chunk", created, model };
      send({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
      const hb = setInterval(() => { try { controller.enqueue(enc.encode(": keepalive\n\n")); } catch {} }, 15000);

      // Live token passthrough (non-tool only). Track exactly what we've sent so the
      // final render emits only the not-yet-streamed remainder. session.ts guarantees
      // every forwarded delta extends the answer, so `sent` is always a prefix of the
      // final text — the remainder is a clean tail, never a duplicate.
      let sent = "";
      const liveDelta = hasTools ? undefined : (delta: string) => {
        if (!delta) return;
        sent += delta;
        try { send({ ...base, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] }); } catch {}
      };

      let p: Produced;
      try {
        p = await produce(liveDelta);
      } catch (err: any) {
        console.error("[produce error stream]", err.stack || err);
        p = { kind: "error", resp: jsonResponse(502, { error: { message: err?.message ?? "stream error", type: "upstream_error" } }) };
      }
      clearInterval(hb);
      try {
        if (p.kind === "error") {
          let message = "upstream error";
          try { message = (JSON.parse(await p.resp.text())?.error?.message) || message; } catch {}
          // HTTP 200 is already committed, so surface the failure as an in-stream error chunk.
          send({ ...base, error: { message, type: "upstream_error" } });
        } else if (p.kind === "tools") {
          p.toolCalls.forEach((tc, i) =>
            send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } }] }, finish_reason: null }] }));
          send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], ...(includeUsage ? { usage: usage() } : {}) });
        } else {
          const finalText = p.text ?? "";
          const remainder = finalText.startsWith(sent) ? finalText.slice(sent.length) : "";
          if (!finalText.startsWith(sent)) log.info(`Streamed prefix diverged from final text (sent ${sent.length}, final ${finalText.length} chars) — not re-sending to avoid duplication`);
          if (remainder) send({ ...base, choices: [{ index: 0, delta: { content: remainder }, finish_reason: null }] });
          send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: outputFinishReason(finalText) }], ...(includeUsage ? { usage: usage() } : {}) });
        }
      } catch {
        // client likely disconnected mid-emit — nothing more to do
      } finally {
        try { controller.enqueue(enc.encode("data: [DONE]\n\n")); controller.close(); } catch {}
      }
    },
  }));
}

/**
 * Build the OpenAI-style `usage` block from whatever diagnostic info M365 gave
 * us. Token counts are NOT exposed by M365's WebSocket API (we'd need to count
 * locally with a tokenizer that matches the underlying model — see the doc on
 * token-usage hypotheses). What M365 does send is a **conversation quota**:
 * how many user messages out of the 600-per-conversation cap have been spent.
 *
 * That's a different axis from token-window utilisation, but it's the closest
 * thing we have to "remaining budget", so we surface it as extension fields
 * (`x_m365_*`) alongside the zeroed standard counters. Real OpenAI clients
 * ignore unknown extension fields; curious users can read them.
 */
function buildUsage(
  throttle: { current: number; max: number } | null,
  contentOrigin?: string | null,
  messageType?: string | null,
  scores?: Record<string, number> | null,
  turnCount?: number | null,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  if (throttle) {
    base.x_m365_conversation_messages = throttle.current;
    base.x_m365_conversation_max = throttle.max;
    base.x_m365_conversation_pct = Math.min(100, Math.round((throttle.current / throttle.max) * 100));
    base.x_m365_conversation_remaining = Math.max(0, throttle.max - throttle.current);
  }
  if (contentOrigin) base.x_m365_content_origin = contentOrigin;
  if (messageType) base.x_m365_message_type = messageType;
  if (typeof turnCount === "number") base.x_m365_turn_count = turnCount;
  // Disengaged-classifier scores. Empirically: clean tool calls sit at
  // ~1e-13 / ~1e-8, jailbreak-shaped prompts climb to ~1e-3 / ~1e-3. The
  // `dea_violation` component is the one that actually correlates with the
  // Disengaged filter firing — surface that explicitly so clients can monitor
  // their proximity to the threshold.
  if (scores) {
    base.x_m365_classifier_scores = scores;
    if (typeof scores.dea_violation === "number") base.x_m365_dea_score = scores.dea_violation;
    if (typeof scores.BotOffense === "number") base.x_m365_offense_score = scores.BotOffense;
  }
  return base;
}

// --- Helpers ---

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(stream: ReadableStream): Response {
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

function rateLimitMessage(throttle: { current: number; max: number } | null): string {
  return throttle
    ? `M365 Copilot rate limited (${throttle.current}/${throttle.max} messages used). Please wait and try again.`
    : "M365 Copilot returned an empty response. You may be rate limited. Please wait and try again.";
}

function rateLimitResponse(throttle: { current: number; max: number } | null): Response {
  return jsonResponse(429, { error: { message: rateLimitMessage(throttle), type: "rate_limit_error" } });
}

/** Empty upstream reply that is NOT an at-limit throttle — a distinct failure
 *  (content filter, invalid agent/session, transient error) we surface clearly
 *  instead of hanging on a long retry loop. */
function emptyResponseResponse(throttle: { current: number; max: number } | null): Response {
  const detail = throttle ? ` (throttle ${throttle.current}/${throttle.max})` : "";
  return jsonResponse(502, {
    error: {
      message: `M365 Copilot returned an empty response${detail} — likely a content filter, an invalid agent/session, or a transient upstream error.`,
      type: "upstream_empty_response",
    },
  });
}

// (streaming is emitted inline by the early-flushed SSE renderer in
// handleChatCompletion; the old streamText/streamToolCalls helpers were removed.)
