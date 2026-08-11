import { describe, expect, it } from "vitest";
import { IntegrationManager } from "./integrations.js";
import type { ProcessRequest, ProcessRunner } from "./runner.js";

describe("reversible MCP integrations", () => {
  it("adds Claude at user scope and removes only the myclaude entry", async () => {
    const requests: ProcessRequest[] = [];
    const runner: ProcessRunner = { async run(request) {
      requests.push(request);
      return { exitCode: request.args[1] === "get" ? 0 : 0, stdout: "myclaude configured", stderr: "", durationMs: 1 };
    } };
    const manager = new IntegrationManager("/opt/myclaude/mcp.mjs", runner, "/usr/bin/node");
    await manager.add("claude");
    await manager.remove("claude");
    expect(requests[0].args).toEqual(["mcp", "add", "--scope", "user", "myclaude", "--", "/usr/bin/node", "/opt/myclaude/mcp.mjs"]);
    expect(requests.some((request) => request.args.join(" ") === "mcp remove --scope user myclaude")).toBe(true);
    expect(requests.every((request) => !request.args.includes("reset"))).toBe(true);
  });

  it("uses the native Codex MCP command without credentials", async () => {
    const requests: ProcessRequest[] = [];
    const runner: ProcessRunner = { async run(request) { requests.push(request); return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 }; } };
    await new IntegrationManager("/mcp.mjs", runner, "/node").add("codex");
    expect(requests[0]).toMatchObject({ executable: "codex", args: ["mcp", "add", "myclaude", "--", "/node", "/mcp.mjs"] });
    expect(JSON.stringify(requests)).not.toMatch(/token|password|api.?key/i);
  });
});
