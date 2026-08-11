import { describe, expect, it } from "vitest";
import { buildClaudeGatewayModelsPayload, createApp } from "./index.js";

describe("model catalog compatibility", () => {
  it("builds all 21 Claude Code gateway-discoverable aliases", () => {
    const body = buildClaudeGatewayModelsPayload();
    expect(body.has_more).toBe(false);
    expect(body.data).toHaveLength(21);
    expect(body.data[0]).toMatchObject({
      id: "claude-m365--m365-copilot",
      display_name: "m365-copilot",
      type: "model",
    });
    expect(body.data.every((model) => model.id.startsWith("claude"))).toBe(true);
  });

  it("serves Anthropic discovery only when Claude Code marks the request", async () => {
    const app = createApp();
    const res = await app.fetch(new Request("http://localhost/v1/models", {
      headers: { "X-M365-Claude-Code": "1" },
    }));
    const body = await res.json();
    expect(body.data[0].display_name).toBe("m365-copilot");

    const openAiRes = await app.fetch(new Request("http://localhost/v1/models"));
    const openAiBody = await openAiRes.json();
    expect(openAiBody.object).toBe("list");
    expect(openAiBody.data[0].id).toBe("m365-copilot");
  });
});
