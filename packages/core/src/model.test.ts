import { describe, it, expect } from "vitest";
import { ModelSession, isTokenNearExpiry } from "./model.js";
import type { CopilotStream } from "./copilot.js";

/**
 * Offline coverage for the restart-durability auth work:
 *   - isTokenNearExpiry (proactive refresh trigger)
 *   - ModelSession conversationId seeding (session-store hydration)
 *   - proactive refresh wiring (success / not-needed / failure fallback)
 */

function makeJwt(expSeconds?: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify(expSeconds === undefined ? {} : { exp: expSeconds }),
  ).toString("base64url");
  return `${header}.${payload}.sig`;
}

describe("isTokenNearExpiry", () => {
  const NOW = 1_800_000_000_000;

  it("true inside the refresh margin", () => {
    expect(isTokenNearExpiry(makeJwt(NOW / 1000 + 120), 300_000, NOW)).toBe(true);
  });
  it("false with comfortable runway", () => {
    expect(isTokenNearExpiry(makeJwt(NOW / 1000 + 3600), 300_000, NOW)).toBe(false);
  });
  it("true exactly at expiry", () => {
    expect(isTokenNearExpiry(makeJwt(NOW / 1000), 300_000, NOW)).toBe(true);
  });
  it("false without an exp claim (only exp-bearing tokens are refreshed)", () => {
    expect(isTokenNearExpiry(makeJwt(), 300_000, NOW)).toBe(false);
  });
  it("false for empty tokens or zero margin", () => {
    expect(isTokenNearExpiry("", 300_000, NOW)).toBe(false);
    expect(isTokenNearExpiry(makeJwt(NOW / 1000), 0, NOW)).toBe(false);
  });
});

describe("ModelSession conversationId seeding", () => {
  it("seeds the persisted conversation id so a restarted host resumes the thread", () => {
    const session = new ModelSession({
      getToken: async () => "t",
      useAgent: false,
      transport: { chat: async () => ({}) as CopilotStream },
      conversationId: "persisted-cid",
    });
    expect(session.conversationId).toBe("persisted-cid");
  });

  it("generates a fresh conversation id when not seeded", () => {
    const session = new ModelSession({
      getToken: async () => "t",
      useAgent: false,
      transport: { chat: async () => ({}) as CopilotStream },
    });
    expect(session.conversationId).toMatch(/[0-9a-f-]{36}/);
  });
});

describe("proactive token refresh", () => {
  function makeSession(opts: {
    token: string;
    refreshToken: () => Promise<string>;
    seenTokens: string[];
  }): ModelSession {
    return new ModelSession({
      getToken: async () => opts.token,
      refreshToken: opts.refreshToken,
      useAgent: false,
      transport: {
        chat: async (args) => {
          opts.seenTokens.push(args.token);
          return {} as CopilotStream;
        },
      },
    });
  }

  it("refreshes BEFORE the turn when the token is inside the margin", async () => {
    const seenTokens: string[] = [];
    let refreshes = 0;
    const session = makeSession({
      token: makeJwt(Date.now() / 1000 + 60), // expires in 60s < 5min margin
      refreshToken: async () => {
        refreshes += 1;
        return "fresh-token";
      },
      seenTokens,
    });
    await session.run("hello", "m365-copilot", undefined, false);
    expect(refreshes).toBe(1);
    expect(seenTokens).toEqual(["fresh-token"]);
  });

  it("skips refresh when the token still has runway", async () => {
    const seenTokens: string[] = [];
    let refreshes = 0;
    const original = makeJwt(Date.now() / 1000 + 3600); // build ONCE — rebuilding could cross a second boundary
    const session = makeSession({
      token: original,
      refreshToken: async () => {
        refreshes += 1;
        return "fresh-token";
      },
      seenTokens,
    });
    await session.run("hello", "m365-copilot", undefined, false);
    expect(refreshes).toBe(0);
    expect(seenTokens).toEqual([original]);
  });

  it("a failed refresh never blocks the turn — current token rides until its exp", async () => {
    const seenTokens: string[] = [];
    const original = makeJwt(Date.now() / 1000 + 60);
    const session = makeSession({
      token: original,
      refreshToken: async () => {
        throw new Error("msal cache unavailable");
      },
      seenTokens,
    });
    await session.run("hello", "m365-copilot", undefined, false);
    expect(seenTokens).toEqual([original]);
  });
});
