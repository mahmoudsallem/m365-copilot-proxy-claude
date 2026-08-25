import { createLogger } from "@m365-copilot/core";

const log = createLogger("gate");

/**
 * Concurrency gate for M365 turns.
 *
 * The account-level throttle keys on CONVERSATIONS STARTED per unit time
 * (docs/hypotheses.md §9 F13) — raw parallelism is fine, but stampeding fresh
 * conversations trips it. So the gate enforces two independent limits:
 *
 *   - `maxConcurrent`: how many turns may be in flight at once. Default 1
 *     (strict serial — AGENTS.md rule #1); raise via M365_MAX_CONCURRENT_TURNS
 *     if you accept the throttle risk.
 *   - `minConversationGapMs`: minimum spacing between the FIRST turn of two
 *     DIFFERENT conversations — the stampede guard (default 5s). Follow-up
 *     turns inside a conversation are never gap-delayed; a long agent loop
 *     stays fast while N parallel agents start politely staggered.
 *
 * Both tune via env: M365_MAX_CONCURRENT_TURNS, M365_CONVERSATION_START_GAP_MS.
 */
export interface TurnGateOptions {
  maxConcurrent?: number;
  minConversationGapMs?: number;
}

export interface TurnGateStats {
  inflight: number;
  queued: number;
  maxConcurrent: number;
  minConversationGapMs: number;
  distinctConversations: number;
  msSinceLastStart: number | null;
}

export class TurnGate {
  private inflight = 0;
  private lastStartAt = 0;
  private readonly seen = new Set<string>();
  private readonly waiters = new Set<() => void>();
  readonly maxConcurrent: number;
  readonly minConversationGapMs: number;

  constructor(options: TurnGateOptions = {}) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? Number(process.env.M365_MAX_CONCURRENT_TURNS ?? 1));
    this.minConversationGapMs = Math.max(0, options.minConversationGapMs ?? Number(process.env.M365_CONVERSATION_START_GAP_MS ?? 5000));
  }

  stats(): TurnGateStats {
    return {
      inflight: this.inflight,
      queued: this.waiters.size,
      maxConcurrent: this.maxConcurrent,
      minConversationGapMs: this.minConversationGapMs,
      distinctConversations: this.seen.size,
      msSinceLastStart: this.lastStartAt ? Date.now() - this.lastStartAt : null,
    };
  }

  /**
   * Run `fn` while holding one concurrency slot. First turns of new
   * conversations additionally respect the start-gap stagger.
   */
  async run<T>(conversationKey: string, fn: () => Promise<T>): Promise<T> {
    await this.acquire(conversationKey);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire(conversationKey: string): Promise<void> {
    const isNew = !this.seen.has(conversationKey);
    // Loop: blocked acquisitions sleep until either a slot frees (waker) or,
    // for gap-blocked first turns, until the gap expires (timer).
    for (;;) {
      if (this.tryProceed(conversationKey)) return;
      const gapRemaining = isNew && this.lastStartAt
        ? this.minConversationGapMs - (Date.now() - this.lastStartAt)
        : 0;
      await new Promise<void>((resolve) => {
        let waker: (() => void) | null = () => { cleanup(); resolve(); };
        const timer = gapRemaining > 0
          ? setTimeout(() => { cleanup(); resolve(); }, gapRemaining)
          : null;
        const cleanup = () => {
          if (waker) { this.waiters.delete(waker); waker = null; }
          if (timer) clearTimeout(timer);
        };
        this.waiters.add(waker);
      });
    }
  }

  /** Attempt to take a slot right now. Returns false when still blocked. */
  private tryProceed(conversationKey: string): boolean {
    const isNew = !this.seen.has(conversationKey);
    if (this.inflight >= this.maxConcurrent) return false;
    if (isNew && this.lastStartAt && Date.now() - this.lastStartAt < this.minConversationGapMs) return false;
    this.inflight += 1;
    this.lastStartAt = Date.now();
    if (isNew) this.seen.add(conversationKey);
    log.debug(`acquire ok (inflight=${this.inflight}/${this.maxConcurrent}, queued=${this.waiters.size})`);
    return true;
  }

  private release(): void {
    this.inflight = Math.max(0, this.inflight - 1);
    // Wake one waiter; if it is still gap-blocked its own timeout will retry it.
    const next = this.waiters.values().next();
    if (!next.done) {
      const waker = next.value;
      this.waiters.delete(waker);
      waker();
    }
  }
}
