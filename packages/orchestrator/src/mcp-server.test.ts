import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MyClaudeClient } from "./client.js";
import { MCP_PROTOCOL_VERSION, MCP_TOOLS, McpServerSession } from "./mcp-server.js";

const TASK_ID = "00000000-0000-4000-8000-000000000001";

describe("stdio MCP surface", () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  it("negotiates only the implemented version and enforces initialized lifecycle", async () => {
    const session = new McpServerSession({} as MyClaudeClient);
    expect(await session.dispatch(request("ping", "ping", {}))).toEqual({ jsonrpc: "2.0", id: "ping", result: {} });
    await expect(session.dispatch(request(1, "tools/list", {}))).rejects.toMatchObject({ rpcCode: -32002 });
    await expect(session.dispatch(request("bad-init", "initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
    }))).rejects.toMatchObject({ rpcCode: -32602 });
    expect(session.lifecycleState).toBe("new");

    const initialized = await session.dispatch(request(2, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    })) as RpcResponse<{ protocolVersion: string }>;
    expect(initialized.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(session.lifecycleState).toBe("awaiting_initialized");
    await expect(session.dispatch(request(3, "tools/list", {}))).rejects.toMatchObject({ rpcCode: -32002 });

    expect(await session.dispatch(notification("notifications/initialized", {}))).toBeUndefined();
    expect(session.lifecycleState).toBe("initialized");
    const listed = await session.dispatch(request(4, "tools/list", {})) as RpcResponse<{ tools: unknown[] }>;
    expect(listed.result.tools).toHaveLength(10);
    await expect(session.dispatch(request(5, "initialize", { protocolVersion: MCP_PROTOCOL_VERSION }))).rejects.toMatchObject({ rpcCode: -32600 });
  });

  it("exposes only the ten bounded task tools", async () => {
    const expected = ["task_create", "task_submit_plan", "task_start", "task_wait", "task_status", "task_list", "task_evidence", "task_submit_review", "task_request_repair", "task_cancel"];
    expect(MCP_TOOLS.map((tool) => tool.name)).toEqual(expected);
    const schemaProperties = MCP_TOOLS.flatMap((tool) => Object.keys((tool.inputSchema.properties ?? {}) as Record<string, unknown>));
    expect(schemaProperties).not.toEqual(expect.arrayContaining(["command", "shell", "credential", "token", "sandbox", "profile"]));
    const session = await initializedSession({} as MyClaudeClient);
    const response = await session.dispatch(request(1, "tools/list", {})) as RpcResponse<{ tools: unknown[] }>;
    expect(response.result.tools).toHaveLength(10);
  });

  it("maps task calls to the SDK without exposing daemon internals", async () => {
    const root = await mkdtemp(join(tmpdir(), "myclaude-mcp-scope-"));
    roots.push(root);
    const workspace = join(root, "project");
    await mkdir(workspace);
    const client = { createTask: vi.fn().mockResolvedValue({ id: "task" }) } as unknown as MyClaudeClient;
    const session = await initializedSession(client, root);
    const response = await session.dispatch(request("x", "tools/call", {
      name: "task_create",
      arguments: { objective: "do it", workspace },
    })) as RpcResponse<ToolResult>;
    expect(client.createTask).toHaveBeenCalledWith({ objective: "do it", workspace });
    expect(response.result.structuredContent).toEqual({ id: "task" });
    expect(response.result.isError).toBe(false);
  });

  it("prevents MCP planners from selecting a sibling or whole-host workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "myclaude-mcp-boundary-"));
    roots.push(root);
    const project = join(root, "project");
    const sibling = join(root, "sibling");
    await mkdir(project);
    await mkdir(sibling);
    const client = { createTask: vi.fn() } as unknown as MyClaudeClient;
    const session = await initializedSession(client, project);
    const call = (workspace: string) => session.dispatch(request("x", "tools/call", {
      name: "task_create",
      arguments: { objective: "do it", workspace },
    })) as Promise<RpcResponse<ToolResult>>;
    expect((await call(sibling)).result).toMatchObject({ isError: true, structuredContent: { error: true } });
    expect((await call("/")).result).toMatchObject({ isError: true, structuredContent: { error: true } });
    expect(client.createTask).not.toHaveBeenCalled();
  });

  it("returns tool and argument failures as CallToolResult errors", async () => {
    const client = { getTask: vi.fn().mockRejectedValue(new Error("daemon unavailable")) } as unknown as MyClaudeClient;
    const session = await initializedSession(client);
    const failed = await session.dispatch(request(10, "tools/call", {
      name: "task_status",
      arguments: { taskId: TASK_ID },
    })) as RpcResponse<ToolResult>;
    expect(failed.result).toEqual(expect.objectContaining({
      isError: true,
      structuredContent: { error: true, message: "daemon unavailable" },
      content: [{ type: "text", text: "daemon unavailable" }],
    }));

    const malformed = await session.dispatch(request(11, "tools/call", {
      name: "task_status",
      arguments: { taskId: "not-a-uuid" },
    })) as RpcResponse<ToolResult>;
    expect(malformed.result.isError).toBe(true);

    const missingTool = await session.dispatch(request(12, "tools/call", {
      name: "raw_shell",
      arguments: {},
    })) as RpcResponse<ToolResult>;
    expect(missingTool.result).toMatchObject({ isError: true, structuredContent: { error: true } });
  });

  it("never responds to unknown, malformed, or cancellation notifications", async () => {
    const session = new McpServerSession({} as MyClaudeClient);
    expect(await session.dispatch(notification("notifications/unknown", { anything: true }))).toBeUndefined();
    expect(await session.dispatch({ jsonrpc: "invalid", method: "notifications/bad" })).toBeUndefined();
    expect(await session.dispatch(notification("notifications/cancelled", { requestId: 99 }))).toBeUndefined();
    expect(session.lifecycleState).toBe("new");
  });

  it("cancels an in-flight task_wait without emitting a response", async () => {
    let waitSignal: AbortSignal | undefined;
    const client = {
      waitTask: vi.fn((_taskId: string, _timeoutMs: number, options: { signal?: AbortSignal }) => {
        waitSignal = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
        });
      }),
    } as unknown as MyClaudeClient;
    const session = await initializedSession(client);
    const waiting = session.dispatch(request("wait-1", "tools/call", {
      name: "task_wait",
      arguments: { taskId: TASK_ID, timeoutMs: 300_000 },
    }));
    await vi.waitFor(() => expect(client.waitTask).toHaveBeenCalledOnce());

    expect(await session.dispatch(notification("notifications/cancelled", { requestId: "wait-1", reason: "client stopped waiting" }))).toBeUndefined();
    expect(await waiting).toBeUndefined();
    expect(waitSignal?.aborted).toBe(true);
  });
});

async function initializedSession(client: MyClaudeClient, workspaceRoot?: string): Promise<McpServerSession> {
  const session = new McpServerSession(client, { workspaceRoot });
  await session.dispatch(request(0, "initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "vitest", version: "1" },
  }));
  await session.dispatch(notification("notifications/initialized", {}));
  return session;
}

function request(id: string | number, method: string, params: unknown) {
  return { jsonrpc: "2.0", id, method, params } as const;
}

function notification(method: string, params: unknown) {
  return { jsonrpc: "2.0", method, params } as const;
}

interface RpcResponse<T> {
  jsonrpc: "2.0";
  id: string | number;
  result: T;
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent: unknown;
  isError: boolean;
}
