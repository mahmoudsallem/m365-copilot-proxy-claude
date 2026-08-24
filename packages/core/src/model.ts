import { getToken } from "./auth.js";
import { getOrCreateAgent, getOrCreateAgentSingleFlight } from "./agent.js";
import { CopilotSession } from "./session.js";
import { createLogger, trunc } from "./log.js";
import { resolveModel } from "./copilot.js";
import type { CopilotStream } from "./copilot.js";

const log = createLogger("model");

export interface ModelSessionOptions {
  /** Pre-resolved auth token. If not provided, getToken() is called. */
  getToken?: () => Promise<string>;
  /** Whether to attempt agent resolution. Default: true. */
  useAgent?: boolean;
  /** Inject a transport (the thing that actually talks to a backend). Defaults to the real M365 WebSocket transport. */
  transport?: ModelTransport;
}

/**
 * The pluggable bottom edge of a ModelSession: one text turn in, stream out.
 * The default implementation opens a real CopilotSession (M365 SignalR).
 * Tests and M365_FAKE_MODE swap in a scripted transport instead.
 */
export interface ModelTransport {
  chat(args: {
    token: string;
    text: string;
    tone: string;
    signal?: AbortSignal;
    agentId?: string;
    sessionId: string;
    conversationId: string;
    generateImages: boolean;
  }): Promise<CopilotStream>;
  /** Drop any cached underlying connection (called on turn errors before the one retry). */
  reset?(): void;
}

/** The real M365 transport — wraps CopilotSession with the reuse/recreate rules. */
export class RealM365Transport implements ModelTransport {
  private copilotSession: CopilotSession | null = null;
  private agentId: string | undefined = undefined;

  private ensure(agentId: string | undefined, sessionId: string, conversationId: string): CopilotSession {
    if (!this.copilotSession || this.agentId !== agentId) {
      this.copilotSession = new CopilotSession({ agentId, sessionId, conversationId });
      this.agentId = agentId;
    }
    return this.copilotSession;
  }

  async chat(args: {
    token: string;
    text: string;
    tone: string;
    signal?: AbortSignal;
    agentId?: string;
    sessionId: string;
    conversationId: string;
    generateImages: boolean;
  }): Promise<CopilotStream> {
    const sess = this.ensure(args.agentId, args.sessionId, args.conversationId);
    return sess.chat(args.token, args.text, args.tone, args.signal, { generateImages: args.generateImages });
  }

  reset(): void {
    this.copilotSession = null;
  }
}

/**
 * A stateful session for running M365 Copilot.
 * Manages auth, agent resolution, and conversation continuity.
 * String in, stream out.
 *
 * The same sessionId and conversationId are reused across transport
 * reconnections so M365 finds the existing server-side conversation
 * instead of creating a new one.
 */
export class ModelSession {
  private resolveToken: () => Promise<string>;
  private useAgent: boolean;
  private transport: ModelTransport;
  private cachedAgentId: string | null | undefined = undefined;
  private agentResolutionPromise: Promise<string | null> | null = null;

  /** Stable IDs reused across transport reconnections. */
  readonly sessionId: string = crypto.randomUUID();
  private _conversationId: string = crypto.randomUUID();
  /** Current M365 ConversationId (the throttle/Disengage state keys on this). */
  get conversationId(): string {
    return this._conversationId;
  }

  /**
   * Rotate to a FRESH conversation. A conversation that has Disengaged appears to
   * STAY Disengaged (a clean retry in the same conversation kept refusing), so the
   * Disengage-recovery retry needs a new ConversationId, not just a different prompt.
   * See docs §10 F22.
   */
  newConversation(): void {
    this._conversationId = crypto.randomUUID();
    this.transport.reset?.();
    this.currentAgentId = undefined;
  }

  constructor(options: ModelSessionOptions = {}) {
    this.resolveToken = options.getToken ?? getToken;
    this.useAgent = options.useAgent !== false;
    this.transport = options.transport ?? new RealM365Transport();
  }

  /** Number of turns completed against the current conversation. */
  get turnCount(): number {
    return this.turnCounter;
  }

  private turnCounter = 0;

  /** Agent id baked into the current transport state (undefined = no agent). */
  private currentAgentId: string | undefined = undefined;

  private async resolveAgentId(): Promise<string | null> {
    if (this.cachedAgentId !== undefined) {
      return this.cachedAgentId;
    }
    if (this.agentResolutionPromise) {
      return this.agentResolutionPromise;
    }
    this.agentResolutionPromise = getOrCreateAgentSingleFlight()
      .then((agentId) => {
        this.cachedAgentId = agentId;
        return agentId;
      })
      .finally(() => {
        this.agentResolutionPromise = null;
      });
    return this.agentResolutionPromise;
  }

  /**
   * Send text to M365 Copilot and stream back the response.
   *
   * `useAgent` decides whether THIS turn attaches the tool-calling Copilot Studio
   * agent (`threadLevelGptId`). `useAgent` is ONLY enabled if the resolved model
   * explicitly supports agent attachment (`config.supportsAgent`).
   */
  async run(text: string, model: string = "m365-copilot", signal?: AbortSignal, useAgent: boolean = true): Promise<CopilotStream> {
    const token = await this.resolveToken();
    const resolvedModel = resolveModel(model);
    const wantAgent = this.useAgent && useAgent && resolvedModel.config.supportsAgent;

    // Resolve agent ID lazily (persists across resets), single-flighted across concurrent calls
    if (wantAgent && this.cachedAgentId === undefined) {
      try {
        await this.resolveAgentId();
        if (this.cachedAgentId) log.info(`Using agent: ${this.cachedAgentId}`);
        else log.info("No agent available");
      } catch {
        this.cachedAgentId = null;
      }
    }
    const agentForTurn = wantAgent ? (this.cachedAgentId ?? undefined) : undefined;

    log.info(
      `run: model=${resolvedModel.canonicalModel}, tone=${resolvedModel.config.tone}, agent=${
        agentForTurn ?? "none"
      }, turn=${this.turnCounter}, sid=${this.sessionId}, cid=${this.conversationId}, text=${JSON.stringify(
        trunc(text, 200),
      )}`,
    );

    const generateImages = !agentForTurn && !process.env.M365_NO_IMAGE_GEN;

    try {
      const stream = await this.transport.chat({
        token,
        text,
        tone: resolvedModel.config.tone,
        signal,
        agentId: agentForTurn,
        sessionId: this.sessionId,
        conversationId: this.conversationId,
        generateImages,
      });
      this.currentAgentId = agentForTurn;
      this.turnCounter += 1;
      return stream;
    } catch (err: any) {
      // Connection might be stale — recreate via transport.reset() and retry once
      log.info("Session error, reconnecting:", err.message);
      this.transport.reset?.();
      const stream = await this.transport.chat({
        token,
        text,
        tone: resolvedModel.config.tone,
        signal,
        agentId: agentForTurn,
        sessionId: this.sessionId,
        conversationId: this.conversationId,
        generateImages,
      });
      this.currentAgentId = agentForTurn;
      this.turnCounter += 1;
      return stream;
    }
  }

  async refreshAgent(): Promise<boolean> {
    if (this.useAgent === false) return false;
    try {
      const fresh = await getOrCreateAgent({ forceRefresh: true });
      if (fresh !== this.cachedAgentId) {
        log.info(`Agent ID refreshed: ${this.cachedAgentId ?? "none"} -> ${fresh ?? "none"}`);
        this.cachedAgentId = fresh;
        this.transport.reset?.();
        this.currentAgentId = undefined;
        return true;
      }
    } catch (err: any) {
      log.warn("Agent refresh failed:", err.message);
    }
    return false;
  }

  reset(): void {
    this.transport.reset?.();
    this.currentAgentId = undefined;
    this.turnCounter = 0;
  }
}
