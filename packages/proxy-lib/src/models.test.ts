import { describe, expect, it } from "vitest";
import { buildClaudeGatewayModelsPayload, createApp } from "./index.js";

describe("model catalog compatibility", () => {
  it("builds all 21 Claude Code gateway-discoverable aliases", () => {
    const body = buildClaudeGatewayModelsPayload();
    expect(body.has_more).toBe(false);
    expect(body.data).toHaveLength(21);
    expect(body.data[0]).toMatchObject({
      id: "claude-m365--m365-copilot",
      display_name: "m365-copilot [experimental]",
      type: "model",
      max_input_tokens: 128_000,
      max_tokens: 3_072,
      x_m365_certification: "experimental",
    });
    expect(body.data.find((model) => model.id.endsWith("claude-opus"))).toMatchObject({
      display_name: "claude-opus [broken]",
      x_m365_certification: "broken",
      x_m365_auto_selectable: false,
    });
    expect(body.data.every((model) => model.id.startsWith("claude"))).toBe(true);
  });

  it("serves Anthropic discovery only when Claude Code marks the request", async () => {
    const app = createApp();
    const res = await app.fetch(new Request("http://localhost/v1/models", {
      headers: { "X-M365-Claude-Code": "1" },
    }));
    const body = await res.json();
    expect(body.data[0].display_name).toBe("m365-copilot [experimental]");

    const openAiRes = await app.fetch(new Request("http://localhost/v1/models"));
    const openAiBody = await openAiRes.json();
    expect(openAiBody.object).toBe("list");
    expect(openAiBody.data[0].id).toBe("m365-copilot");
    expect(openAiBody.data[0].max_input_tokens).toBe(128_000);
    expect(openAiBody.data[0].max_output_tokens).toBe(3_072);
    expect(openAiBody.data[0].x_m365_certification).toBe("experimental");
  });

  it("allows and exposes the explicit session header through CORS", async () => {
    const res = await createApp().fetch(new Request("http://localhost/v1/chat/completions", {
      method: "OPTIONS",
    }));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toContain("X-M365-Session-ID");
    expect(res.headers.get("access-control-expose-headers")).toBe("X-M365-Session-ID");
  });
});
