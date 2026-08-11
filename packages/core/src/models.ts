/**
 * Truthful model capability registry.
 *
 * M365 selects routes by undocumented `tone` strings.  A tone being accepted is
 * evidence that the route exists; it is not, by itself, proof of the exact model
 * identity behind that route.  Keep those two facts separate here so API clients
 * do not mistake a convenient model id for a vendor guarantee.
 */

export type ModelCertification = "verified" | "experimental" | "broken";
export type IdentityConfidence = "verified" | "self-reported" | "unknown";
export type ToolRoute = "agentless" | "declarative-agent";
export type ToolReliability = "bench-verified" | "unverified" | "broken";

export interface ModelCapability {
  id: string;
  tone: string;
  certification: ModelCertification;
  identity: {
    provider: "microsoft" | "anthropic" | "openai" | "unknown";
    model: string;
    confidence: IdentityConfidence;
  };
  route: {
    plain: "agentless";
    tools: ToolRoute;
  };
  limits: {
    maxInputTokens: number;
    maxOutputTokens: number;
    basis: "conservative-observed";
  };
  toolReliability: ToolReliability;
  autoSelectable: boolean;
  lastTestedServiceVersion: string;
  evaluation?: {
    solved: number;
    attempted: number;
    silentFailures: number;
    meanMessages: number;
  };
  notes?: string;
}

export const CONSERVATIVE_MODEL_LIMITS = Object.freeze({
  maxInputTokens: 128_000,
  maxOutputTokens: 3_072,
  basis: "conservative-observed" as const,
});

const SERVICE_VERSION = "M365 BizChat/Sydney observed 2026-07-07";

type CapabilitySeed = Omit<ModelCapability, "limits" | "lastTestedServiceVersion">;

function capability(seed: CapabilitySeed): Readonly<ModelCapability> {
  return Object.freeze({
    ...seed,
    identity: Object.freeze({ ...seed.identity }),
    route: Object.freeze({ ...seed.route }),
    limits: CONSERVATIVE_MODEL_LIMITS,
    evaluation: seed.evaluation ? Object.freeze({ ...seed.evaluation }) : undefined,
    lastTestedServiceVersion: SERVICE_VERSION,
  });
}

const magic = (id: string, autoSelectable = false): Readonly<ModelCapability> => capability({
  id,
  tone: "magic",
  certification: "experimental",
  identity: { provider: "microsoft", model: "M365 automatic router", confidence: "unknown" },
  route: { plain: "agentless", tools: "declarative-agent" },
  toolReliability: "bench-verified",
  autoSelectable,
  evaluation: { solved: 8, attempted: 8, silentFailures: 0, meanMessages: 2.4 },
  notes: "Tool behavior was 8/8 on an easy historical suite but conflicts with a newer harder n=1 failure; production gates have not run.",
});

const claudeSonnet = (id: string, autoSelectable = false): Readonly<ModelCapability> => capability({
  id,
  tone: "Claude_Sonnet",
  certification: "experimental",
  identity: { provider: "anthropic", model: "Claude Sonnet 4.5", confidence: "self-reported" },
  route: { plain: "agentless", tools: "agentless" },
  toolReliability: "bench-verified",
  autoSelectable,
  evaluation: { solved: 8, attempted: 8, silentFailures: 0, meanMessages: 5.3 },
  notes: "Identity is repeatedly self-reported; 8/8 was an easy historical suite and production gates have not run.",
});

function experimental(
  id: string,
  tone: string,
  provider: ModelCapability["identity"]["provider"] = "unknown",
  model = "Undisclosed M365 route",
  tools: ToolRoute = "declarative-agent",
): Readonly<ModelCapability> {
  return capability({
    id,
    tone,
    certification: "experimental",
    identity: { provider, model, confidence: "unknown" },
    route: { plain: "agentless", tools },
    toolReliability: "unverified",
    autoSelectable: false,
    notes: "Tone acceptance is verified, but identity and production reliability are not certified.",
  });
}

/** Every public model id, including aliases, has one explicit capability record. */
export const MODEL_CAPABILITIES: Readonly<Record<string, Readonly<ModelCapability>>> = Object.freeze({
  "m365-copilot": magic("m365-copilot", true),
  auto: magic("auto"),
  quick: experimental("quick", "Gpt_Quick", "openai", "Undisclosed GPT quick route"),
  "think-deeper": experimental("think-deeper", "Gpt_Reasoning", "openai", "Undisclosed GPT reasoning route"),

  claude: claudeSonnet("claude"),
  "claude-sonnet": claudeSonnet("claude-sonnet", true),
  "claude-sonnet-4.5": claudeSonnet("claude-sonnet-4.5"),
  "claude-sonnet-think-deeper": experimental(
    "claude-sonnet-think-deeper",
    "Claude_Sonnet_Reasoning",
    "anthropic",
    "Claude Sonnet reasoning route",
    "agentless",
  ),
  "claude-opus": capability({
    id: "claude-opus",
    tone: "Claude_Opus",
    certification: "broken",
    identity: { provider: "unknown", model: "Unverified Claude Opus route", confidence: "unknown" },
    route: { plain: "agentless", tools: "agentless" },
    toolReliability: "broken",
    autoSelectable: false,
    evaluation: { solved: 0, attempted: 3, silentFailures: 3, meanMessages: 0 },
    notes: "Accepted tone but 0/3 historical agent-less probes; never select automatically.",
  }),

  "gpt-5.5": experimental("gpt-5.5", "Gpt_5_5_Chat", "openai", "Unverified GPT-5.5 chat route"),
  "gpt-5.5-quick": experimental("gpt-5.5-quick", "Gpt_5_5_Chat", "openai", "Unverified GPT-5.5 chat route"),
  "gpt-5.5-think-deeper": experimental("gpt-5.5-think-deeper", "Gpt_5_5_Reasoning", "openai", "Unverified GPT-5.5 reasoning route"),

  "gpt-5.4": experimental("gpt-5.4", "Gpt_5_4_Reasoning", "openai", "Unverified GPT-5.4 reasoning route"),
  "gpt-5.4-think-deeper": experimental("gpt-5.4-think-deeper", "Gpt_5_4_Reasoning", "openai", "Unverified GPT-5.4 reasoning route"),
  "gpt-5.4-quick": experimental("gpt-5.4-quick", "Gpt_5_4_Quick", "openai", "Unverified GPT-5.4 quick route"),

  "gpt-5.3": experimental("gpt-5.3", "Gpt_5_3_Quick", "openai", "Unverified GPT-5.3 quick route"),
  "gpt-5.3-quick": experimental("gpt-5.3-quick", "Gpt_5_3_Quick", "openai", "Unverified GPT-5.3 quick route"),
  "gpt-5.3-think-deeper": experimental("gpt-5.3-think-deeper", "Gpt_5_3_Reasoning", "openai", "Unverified GPT-5.3 reasoning route"),

  "gpt-5.2": experimental("gpt-5.2", "Gpt_5_2_Quick", "openai", "Unverified GPT-5.2 quick route"),
  "gpt-5.2-quick": experimental("gpt-5.2-quick", "Gpt_5_2_Quick", "openai", "Unverified GPT-5.2 quick route"),
  "gpt-5.2-think-deeper": experimental("gpt-5.2-think-deeper", "Gpt_5_2_Reasoning", "openai", "Unverified GPT-5.2 reasoning route"),
});

export function getAvailableModels(): string[] {
  return Object.keys(MODEL_CAPABILITIES);
}

export function getAvailableModelCapabilities(): Readonly<ModelCapability>[] {
  return Object.values(MODEL_CAPABILITIES);
}

export function getModelCapability(model: string): Readonly<ModelCapability> | undefined {
  return MODEL_CAPABILITIES[model];
}

/** Resolve aliases/unknown client labels without ever routing an Opus label to Opus implicitly. */
export function resolveModelCapability(model: string): Readonly<ModelCapability> {
  const exact = getModelCapability(model);
  if (exact) return exact;
  if (/^claude/i.test(model)) return MODEL_CAPABILITIES["claude-sonnet"];
  return MODEL_CAPABILITIES["m365-copilot"];
}

export function getToneForModel(model: string): string {
  return resolveModelCapability(model).tone;
}

/**
 * Pick only from certified routes.  Solve rate wins, then silent failures,
 * message cost, and finally id for deterministic ties.
 */
export function getDefaultModel(): string {
  const candidates = getAvailableModelCapabilities()
    .filter((entry) => entry.autoSelectable && entry.certification === "verified")
    .sort((a, b) => {
      const ae = a.evaluation;
      const be = b.evaluation;
      const ar = ae ? ae.solved / Math.max(1, ae.attempted) : 0;
      const br = be ? be.solved / Math.max(1, be.attempted) : 0;
      return br - ar ||
        (ae?.silentFailures ?? Number.MAX_SAFE_INTEGER) - (be?.silentFailures ?? Number.MAX_SAFE_INTEGER) ||
        (ae?.meanMessages ?? Number.MAX_SAFE_INTEGER) - (be?.meanMessages ?? Number.MAX_SAFE_INTEGER) ||
        a.id.localeCompare(b.id);
    });
  // No route has passed the expanded production gates yet. Preserve the current
  // Claude gateway default as an explicitly provisional fallback; its registry
  // record remains experimental and automatic promotion cannot select it.
  return candidates[0]?.id ?? "gpt-5.5-think-deeper";
}
