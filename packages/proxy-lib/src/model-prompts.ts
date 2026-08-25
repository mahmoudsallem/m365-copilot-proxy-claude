import { getSystemPrompt } from "@m365-copilot/core";

/**
 * Model → its own real system prompt, auto-routed.
 *
 * Maps the requested model name onto the matching system prompt in the local
 * corpus (vendor/system-prompts-leaks, indexed by core/prompts.ts): ask for a
 * Claude model and Claude's actual production prompt is injected; ask for Grok
 * and Grok's is. Candidates are ordered newest→oldest and resolved against the
 * corpus with first-hit-wins, so corpus updates never break the route table.
 *
 * Opt-in via M365_MODEL_PROMPTS=1 (big injected prompts raise Disengaged risk).
 * Explicit per-request specs (x-m365-system-prompt header / M365_SYSTEM_PROMPT)
 * always win over the auto-route.
 */

interface PromptRoute {
  /** Matches a lowercased requested model name. */
  pattern: RegExp;
  /** Corpus names tried in order; first one present in the index wins. */
  candidates: string[];
}

const ROUTES: PromptRoute[] = [
  // --- Anthropic (order matters: Code > Opus > Sonnet/Haiku/generic) ---
  { pattern: /(claude|anthropic)[^a-z0-9]*(code|codex)|^code\b/, candidates: [
    "Anthropic/claude-code/claude-code-opus-5",
    "Anthropic/claude-code/claude-code-sonnet-5",
    "Anthropic/claude-code/claude-code-opus-4.8",
    "Anthropic/claude-code/claude-code-sonnet-4.6",
  ]},
  { pattern: /opus/, candidates: [
    "Anthropic/claude-opus-5", "Anthropic/claude-opus-4.8", "Anthropic/claude-opus-4.7", "Anthropic/claude-opus-4.6",
  ]},
  // Bare "haiku" resolves canonically to Claude Sonnet (no Haiku chat prompt in
  // the corpus), so it rides the Sonnet chain.
  { pattern: /claude|anthropic|sonnet|haiku/, candidates: [
    "Anthropic/claude-sonnet-5", "Anthropic/claude-opus-5", "Anthropic/claude-sonnet-4.6",
  ]},

  // --- OpenAI / ChatGPT / Codex (specific versions before generic GPT) ---
  { pattern: /5\.6|\b(sol|terra|luna)\b/, candidates: ["OpenAI/gpt-5.6-sol", "OpenAI/Codex/gpt-5.6-sol"] },
  { pattern: /codex/, candidates: ["OpenAI/Codex/gpt-5.5", "OpenAI/Codex/gpt-5.4", "OpenAI/Codex/codex-full"] },
  { pattern: /gpt-?5\.5.*(think|reason)/, candidates: ["OpenAI/gpt-5.5-thinking"] },
  { pattern: /gpt-?5\.5/, candidates: ["OpenAI/gpt-5.5-instant", "OpenAI/gpt-5.5-thinking"] },
  { pattern: /gpt-?5\.[234].*(think|reason)/, candidates: ["OpenAI/gpt-5.2-thinking", "OpenAI/gpt-5.4-thinking", "OpenAI/gpt-5-thinking"] },
  { pattern: /\bo[134]\b|mini-(high|low|medium)/, candidates: ["OpenAI/API/o3-high-api", "OpenAI/API/o4-mini-high"] },
  { pattern: /chatgpt|gpt-?4\.5/, candidates: ["OpenAI/chatgpt-4.5"] },
  { pattern: /gpt-?4o/, candidates: ["OpenAI/gpt-4o"] },
  { pattern: /gpt|^o\d/, candidates: [
    "OpenAI/gpt-5.5-thinking", "OpenAI/gpt-5.2-thinking", "OpenAI/gpt-5-thinking", "OpenAI/gpt-4o",
  ]},

  // --- Google ---
  { pattern: /gemini.*flash/, candidates: ["Google/gemini-3.5-flash", "Google/gemini-3-flash"] },
  { pattern: /gemini|jules|antigravity/, candidates: ["Google/gemini-3.1-pro", "Google/gemini-3-pro", "Google/gemini-2.5-pro-webapp"] },

  // --- xAI ---
  { pattern: /grok/, candidates: ["xAI/grok-4.5", "xAI/grok-4.2", "xAI/grok-4-with-new-safety-instructions", "xAI/grok-3"] },

  // --- Microsoft / Copilot family (this proxy's home turf, incl. its flavor
  // aliases: auto, quick, think-deeper) ---
  { pattern: /vscode|visual studio/, candidates: ["Microsoft/vscode-copilot-agent"] },
  { pattern: /copilot|m365|^(auto|quick|think[-_]?deeper)\b/, candidates: ["Microsoft/github-copilot", "Microsoft/copilot-cli"] },

  // --- Other coding tools & model families ---
  { pattern: /cursor/, candidates: ["Cursor/cursor"] },
  { pattern: /devin/, candidates: ["Misc/devin-cli"] },
  { pattern: /deepseek/, candidates: ["DeepSeek/deepseek-chat"] },
  { pattern: /kimi/, candidates: ["Kimi/kimi-3", "Kimi/kimi-2.6"] },
  { pattern: /qwen/, candidates: ["Qwen/qwen3.8-max", "Qwen/qwen3.6-plus"] },
  { pattern: /llama|meta/, candidates: ["Meta/muse-spark-1.1", "Meta/meta-spark"] },
  { pattern: /mistral/, candidates: ["Mistral/mistral-medium-3.5", "Mistral/mistral-code"] },
  { pattern: /perplexity/, candidates: ["Perplexity/perplexity-ai"] },
  { pattern: /notion/, candidates: ["Notion/notion-ai"] },
];

export function modelPromptEnabled(): boolean {
  return process.env.M365_MODEL_PROMPTS === "1";
}

/** Ordered corpus-name candidates for a requested model (empty when unrouted). */
export function modelPromptCandidates(model: string | undefined | null): string[] {
  if (!model) return [];
  const m = model.toLowerCase();
  for (const route of ROUTES) {
    if (route.pattern.test(m)) return route.candidates;
  }
  return [];
}

export interface RoutedModelPrompt {
  /** Corpus name of the prompt that matched. */
  name: string;
  /** Full prompt text (possibly capped by M365_MODEL_PROMPT_MAX_CHARS). */
  text: string;
  truncated: boolean;
}

/**
 * Resolve the routed system prompt for a model against the indexed corpus.
 * Returns null when disabled, unrouted, or no candidate exists — never throws,
 * so an auto-route miss can't fail a request that would otherwise work.
 */
export function resolveModelSystemPrompt(model: string | undefined | null): RoutedModelPrompt | null {
  if (!modelPromptEnabled()) return null;
  // Corpus prompts run 30k-230k chars; M365 disengages on huge injections
  // (AGENTS.md §9), so cap by default. Override with 0 = unlimited.
  const capRaw = process.env.M365_MODEL_PROMPT_MAX_CHARS;
  const cap = capRaw?.trim() ? Number(capRaw) : NaN;
  const maxChars = Number.isFinite(cap) && cap >= 0 ? cap : 12_000;
  for (const name of modelPromptCandidates(model)) {
    const raw = getSystemPrompt(name);
    if (raw == null || raw.trim().length === 0) continue;
    if (raw.length > maxChars) {
      return { name, text: `${raw.slice(0, maxChars).trimEnd()}\n\n[system prompt truncated to fit upstream limits]`, truncated: true };
    }
    return { name, text: raw, truncated: false };
  }
  return null;
}
