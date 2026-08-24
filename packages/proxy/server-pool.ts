import { SessionPool } from "@m365-copilot/proxy-lib";
import { FakeTransport, type ModelSessionOptions } from "@m365-copilot/core";

/**
 * Process-wide session pool shared by every request.
 *
 * The pool maps each distinct conversation to its own M365 session, so a single
 * pool for the whole server is exactly the behaviour the old `createApp()` had
 * (it created one pool per app instance).
 *
 * Set M365_FAKE_MODE=1 to swap the real M365 WebSocket backend for the scripted
 * FakeTransport — full stack, zero auth/network/quota. Used by the E2E suite and
 * for sandboxed harness validation (`pnpm test:e2e:sandbox`).
 */
function buildSessionOptions(): ModelSessionOptions {
  if (process.env.M365_FAKE_MODE === "1") {
    return {
      getToken: async () => "fake-token",
      useAgent: false,
      transport: new FakeTransport({
        command: process.env.M365_FAKE_COMMAND,
      }),
    };
  }
  return {};
}

export const pool = new SessionPool(buildSessionOptions());
