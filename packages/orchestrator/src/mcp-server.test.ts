import { describe, expect, it, vi } from "vitest";
import type { MyClaudeClient } from "./client.js";
import { dispatchMcpRequest, MCP_TOOLS } from "./mcp-server.js";

describe("stdio MCP surface", () => {
  it("exposes only the ten bounded task tools", async () => {
    const expected = ["task_create", "task_submit_plan", "task_start", "task_wait", "task_status", "task_list", "task_evidence", "task_submit_review", "task_request_repair", "task_cancel"];
    expect(MCP_TOOLS.map((tool) => tool.name)).toEqual(expected);
    const schemaProperties = MCP_TOOLS.flatMap((tool) => Object.keys((tool.inputSchema.properties ?? {}) as Record<string, unknown>));
    expect(schemaProperties).not.toEqual(expect.arrayContaining(["command", "shell", "credential", "token", "sandbox", "profile"]));
    const response = await dispatchMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, {} as MyClaudeClient) as { result: { tools: unknown[] } };
    expect(response.result.tools).toHaveLength(10);
  });

  it("maps task calls to the SDK without exposing daemon internals", async () => {
    const client = { createTask: vi.fn().mockResolvedValue({ id: "task" }) } as unknown as MyClaudeClient;
    const response = await dispatchMcpRequest({ jsonrpc: "2.0", id: "x", method: "tools/call", params: { name: "task_create", arguments: { objective: "do it", workspace: "/tmp" } } }, client) as { result: { structuredContent: unknown } };
    expect(client.createTask).toHaveBeenCalledWith({ objective: "do it", workspace: "/tmp" });
    expect(response.result.structuredContent).toEqual({ id: "task" });
  });
});
