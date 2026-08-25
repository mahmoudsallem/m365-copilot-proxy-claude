// Tone-health: upstream failure classification, per-tone circuit breaker, and
// fallback routing. Signatures per docs/hypotheses.md F13/F16.3/F22:
//   throttle     — empty turn, healthy conversation counter, ReferencesListComplete tail;
//                  account-keyed → other tones fail too, backoff must win, NEVER failover.
//   disengaged   — explicit messageType:"Disengaged" frame; prompt-shape, not tone health.
//   dead_agent   — instant empty (~<2.5s) with throttle:null; fixed by refreshAgent.
//   tone_outage  — turnState:"Failed" / fast hard-fail with a live counter; the one class
//                  worth failing over on (F16.3: Sonnet pool InternalError for ~4h).
import { createLogger } from "@m365-copilot/core";

const log = createLogger("health");

export type FailureClass = "throttle" | "disengaged" | "dead_agent" | "tone_outage" | "none";

export interface FailureSignal {
  hasContent: boolean;
  messageType: string | null;
  throttle: { current: number; max: number } | null;
  turnState: string | null;
  elapsedMs: number;
}

export function classifyFailure(s: FailureSignal): FailureClass {
  if (s.hasContent) return "none";
  if (s.messageType === "Disengaged") return "disengaged";
  if (s.throttle === null && s.elapsedMs < 2_500) return "dead_agent";
  if (s.turnState === "Failed") return "tone_outage";
  if (s.messageType === "ReferencesListComplete") return "throttle";
  // Fast empties with a live counter lean outage (EarlyProgress-then-drop);
  // slow ones are indistinguishable from throttle — treat as throttle so the
  // degradation backoff owns them instead of burning fallback conversations.
  if (s.elapsedMs < 5_000) return "tone_outage";
  return "throttle";
}

// --- Per-tone circuit breaker ---

const BREAKER_THRESHOLD = Number(process.env.M365_BREAKER_THRESHOLD ?? 3);
const BREAKER_COOLDOWN_MS = Number(process.env.M365_BREAKER_COOLDOWN_MS ?? 600_000);

interface BreakerState {
  consecutiveFailures: number;
  openedAt: number | null;
  probeClaimed: boolean;
}

export type BreakerStatus = "closed" | "open" | "half_open";

/**
 * Tracks consecutive tone_outage failures per canonical model. After
 * BREAKER_THRESHOLD in a row the tone is skipped by the router for
 * BREAKER_COOLDOWN_MS, after which ONE probe request may try it again
 * (half-open): success closes the breaker, failure re-opens it.
 */
export class ToneHealth {
  private states = new Map<string, BreakerState>();

  private get(model: string): BreakerState {
    let s = this.states.get(model);
    if (!s) {
      s = { consecutiveFailures: 0, openedAt: null, probeClaimed: false };
      this.states.set(model, s);
    }
    return s;
  }

  recordSuccess(model: string): void {
    const s = this.get(model);
    if (s.openedAt !== null || s.consecutiveFailures > 0) {
      log.info(`Tone ${model}: healthy again — breaker closed`);
    }
    s.consecutiveFailures = 0;
    s.openedAt = null;
    s.probeClaimed = false;
  }

  recordFailure(model: string): void {
    const s = this.get(model);
    s.consecutiveFailures += 1;
    if (s.consecutiveFailures >= BREAKER_THRESHOLD && s.openedAt === null) {
      s.openedAt = Date.now();
      s.probeClaimed = false;
      log.warn(
        `Tone ${model}: ${s.consecutiveFailures} consecutive tone_outage failures — breaker OPEN for ${Math.round(BREAKER_COOLDOWN_MS / 1000)}s`,
      );
    }
  }

  status(model: string): BreakerStatus {
    const s = this.states.get(model);
    if (!s || s.openedAt === null) return "closed";
    if (Date.now() - s.openedAt >= BREAKER_COOLDOWN_MS) {
      return s.probeClaimed ? "open" : "half_open";
    }
    return "open";
  }

  /**
   * Routing hint: true when requests should be steered away. In the half-open
   * window this claims the single probe slot (returns false exactly once per
   * cooldown so exactly one request tests the recovering tone).
   */
  shouldRouteAway(model: string): boolean {
    const status = this.status(model);
    if (status === "closed") return false;
    if (status === "open") return true;
    this.get(model).probeClaimed = true;
    return false; // half-open: let this one request through as the probe
  }

  resetForTests(): void {
    this.states.clear();
  }

  /** Dashboard/ops view of every tracked tone. */
  snapshot(): Array<{ model: string; status: BreakerStatus; consecutiveFailures: number }> {
    return [...this.states.entries()].map(([model, s]) => ({
      model,
      status: this.status(model),
      consecutiveFailures: s.consecutiveFailures,
    }));
  }
}

export const toneHealth = new ToneHealth();

// --- Failover routing ---

/** Terminal fallback: gpt-5.5 is the default magic-tone model and historically the most available. */
const TONE_FALLBACKS: Record<string, string[]> = {
  "claude-sonnet": ["claude-opus", "gpt-5.5"],
  "claude-sonnet-think-deeper": ["claude-opus", "gpt-5.5"],
  "claude-opus": ["claude-sonnet", "gpt-5.5"],
};

export function failoverEnabled(): boolean {
  return !process.env.M365_NO_TONE_FAILOVER;
}

export function fallbackChain(model: string): string[] {
  return TONE_FALLBACKS[model] ?? [];
}

/** First model in the chain that isn't routed away by the breaker (claims probes). */
export function nextHealthyFallback(model: string): string | null {
  if (!failoverEnabled()) return null;
  for (const alt of fallbackChain(model)) {
    if (!toneHealth.shouldRouteAway(alt)) return alt;
  }
  return null;
}
