import { getToken } from "./auth.js";
import { getOrCreateAgent, getOrCreateAgentSingleFlight } from "./agent.js";
import { CopilotSession } from "./session.js";
import { createLogger } from "./log.js";
import type { CopilotStream } from "./copilot.js";

const log = createLogger("model");

export interface ModelSessionOptions {
  /** Pre-resolved auth token. If not provided, getToken() is called. */
  getToken?: () => Promise<string>;
  /** Whether to attempt agent resolution. Default: true. */
  useAgent?: boolean;
  /** Stable, caller-generated UUID propagated to M365 as X-SessionId. */
  sessionId?: string;
}

/**
 * A stateful session for running M365 Copilot.
 * Manages auth, agent resolution, and conversation continuity.
 * String in, stream out.
 *
 * The same sessionId and conversationId are reused across CopilotSession
 * reconnections so M365 finds the existing server-side conversation
 * instead of creating a new one.
 */
export class ModelSession {
  private resolveToken: () => Promise<string>;
  private useAgent: boolean;
  private copilotSession: CopilotSession | null = null;
  private cachedAgentId: string | null | undefined = undefined;
  private agentResolutionPromise: Promise<string | null> | null = null;
  private sessionCreationPromise: Promise<CopilotSession> | null = null;

  /** Stable IDs reused across CopilotSession reconnections. */
  readonly sessionId: string;
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
    this.reset();
  }

  constructor(options: ModelSessionOptions = {}) {
    this.resolveToken = options.getToken ?? getToken;
    this.useAgent = options.useAgent !== false;
    this.sessionId = options.sessionId ?? crypto.randomUUID();
  }

  /** Number of turns completed in this session */
  get turnCount(): number {
    return this.copilotSession?.turnCount ?? 0;
  }

  /** Agent id baked into the current copilotSession (undefined = no agent). */
  private currentAgentId: string | undefined = undefined;

  private createCopilotSession(agentId: string | undefined): CopilotSession {
    return new CopilotSession({
      agentId,
      sessionId: this.sessionId,
      conversationId: this.conversationId,
    });
  }

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
   * agent (`threadLevelGptId`). The handler derives this from the capability
   * registry and may explicitly override it with M365_FORCE_AGENT.
   */
  async run(text: string, model: string = "m365-copilot", signal?: AbortSignal, useAgent: boolean = true): Promise<CopilotStream> {
    const token = await this.resolveToken();
    const wantAgent = this.useAgent && useAgent;

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

    // Single-flight session creation to prevent racing concurrent initial turns
    if (!this.copilotSession || this.currentAgentId !== agentForTurn) {
      if (!this.sessionCreationPromise) {
        this.sessionCreationPromise = (async () => {
          const sess = this.createCopilotSession(agentForTurn);
          this.copilotSession = sess;
          this.currentAgentId = agentForTurn;
          return sess;
        })().finally(() => {
          this.sessionCreationPromise = null;
        });
      }
      await this.sessionCreationPromise;
    }

    const currentSession = this.copilotSession!;
    log.info(`run: model=${model}, agent=${agentForTurn ?? "none"}, turn=${currentSession.turnCount}, sid=${this.sessionId}, cid=${this.conversationId}, promptChars=${text.length}`);

    const turnOpts = { generateImages: !agentForTurn && !process.env.M365_NO_IMAGE_GEN };

    try {
      return await currentSession.chat(token, text, model, signal, turnOpts);
    } catch (err: any) {
      // Session might be stale — reconnect with same IDs
      log.info("Session error, reconnecting:", err.message);
      this.copilotSession = this.createCopilotSession(agentForTurn);
      this.currentAgentId = agentForTurn;
      return await this.copilotSession.chat(token, text, model, signal, turnOpts);
    }
  }

  async refreshAgent(): Promise<boolean> {
    if (!this.useAgent) return false;
    try {
      const fresh = await getOrCreateAgent({ forceRefresh: true });
      if (fresh !== this.cachedAgentId) {
        log.info(`Agent ID refreshed: ${this.cachedAgentId ?? "none"} -> ${fresh ?? "none"}`);
        this.cachedAgentId = fresh;
        this.copilotSession = null;
        this.currentAgentId = undefined;
        return true;
      }
    } catch (err: any) {
      log.warn("Agent refresh failed:", err.message);
    }
    return false;
  }

  reset(): void {
    this.copilotSession = null;
    this.cachedAgentId = undefined;
    this.currentAgentId = undefined;
  }
}
