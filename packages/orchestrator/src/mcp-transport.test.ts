import { describe, expect, it } from "vitest";
import type { MyClaudeClient } from "./client.js";
import { MCP_PROTOCOL_VERSION, McpServerSession } from "./mcp-server.js";
import { dispatchMcpLine } from "./mcp-transport.js";

describe("MCP stdio transport", () => {
  it("returns parse and request errors with the correct JSON-RPC ids", async () => {
    const session = new McpServerSession({} as MyClaudeClient);
    expect(JSON.parse((await dispatchMcpLine("{", session))!)).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700 },
    });
    expect(JSON.parse((await dispatchMcpLine(JSON.stringify({ jsonrpc: "2.0", id: "bad", method: 3 }), session))!)).toMatchObject({
      id: "bad",
      error: { code: -32600 },
    });
    expect(JSON.parse((await dispatchMcpLine("[]", session))!)).toMatchObject({
      id: null,
      error: { code: -32600 },
    });
  });

  it("writes no line for notifications, including unknown notifications", async () => {
    const session = new McpServerSession({} as MyClaudeClient);
    expect(await dispatchMcpLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/unknown", params: {} }), session)).toBeUndefined();
    expect(await dispatchMcpLine(JSON.stringify({ jsonrpc: "broken", method: "notifications/unknown" }), session)).toBeUndefined();
  });

  it("preserves lifecycle across lines in one stdio session", async () => {
    const session = new McpServerSession({ listTasks: async () => [] } as unknown as MyClaudeClient);
    const init = JSON.parse((await dispatchMcpLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    }), session))!);
    expect(init.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(await dispatchMcpLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), session)).toBeUndefined();
    const call = JSON.parse((await dispatchMcpLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "task_list", arguments: {} },
    }), session))!);
    expect(call.result).toMatchObject({ isError: false, structuredContent: { result: [] } });
  });
});
