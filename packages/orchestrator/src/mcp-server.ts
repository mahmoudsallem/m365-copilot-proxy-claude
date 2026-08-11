import { z } from "zod";
import { MyClaudeClient } from "./client.js";
import { parsePlan } from "./schemas.js";
import { errorMessage } from "./util.js";
import { assertWorkspaceAllowed } from "./workspace-policy.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export const MCP_TOOLS = [
  {
    name: "task_create",
    description: "Create a durable MyClaude task draft. Does not execute it.",
    inputSchema: { type: "object", additionalProperties: false, required: ["objective", "workspace"], properties: { objective: { type: "string" }, workspace: { type: "string" }, title: { type: "string" } } },
  },
  {
    name: "task_submit_plan",
    description: "Submit an immutable myclaude.plan/v1 artifact. Credentials are rejected.",
    inputSchema: { type: "object", additionalProperties: false, required: ["plan"], properties: { plan: { type: "object" } } },
  },
  { name: "task_start", description: "Queue a planned task under the daemon's fixed execution policy.", inputSchema: taskIdSchema() },
  { name: "task_wait", description: "Wait briefly for task progress or completion.", inputSchema: { type: "object", additionalProperties: false, required: ["taskId"], properties: { taskId: { type: "string", format: "uuid" }, timeoutMs: { type: "integer", minimum: 0, maximum: 300000 } } } },
  { name: "task_status", description: "Read task state and metadata.", inputSchema: taskIdSchema() },
  { name: "task_list", description: "List durable tasks.", inputSchema: { type: "object", additionalProperties: false, properties: {} } },
  { name: "task_evidence", description: "Read deterministic execution, validation, and review evidence.", inputSchema: taskIdSchema() },
  { name: "task_submit_review", description: "Submit a structured myclaude.review/v1 artifact.", inputSchema: { type: "object", additionalProperties: false, required: ["review"], properties: { review: { type: "object" } } } },
  { name: "task_request_repair", description: "Queue a bounded repair using prose instructions; no raw shell or sandbox controls are exposed.", inputSchema: { type: "object", additionalProperties: false, required: ["taskId"], properties: { taskId: { type: "string", format: "uuid" }, instructions: { type: "array", items: { type: "string" } } } } },
  { name: "task_cancel", description: "Cancel queued or running work.", inputSchema: taskIdSchema() },
] as const;

type RpcId = string | number;
type LifecycleState = "new" | "awaiting_initialized" | "initialized" | "closed";

export interface McpServerOptions {
  workspaceRoot?: string;
}

const requestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.unknown().optional(),
});

const notificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string(),
  params: z.unknown().optional(),
});

/**
 * Stateful MCP connection handler. A new instance is required for every stdio
 * connection so initialization and cancellation never leak across clients.
 */
export class McpServerSession {
  private lifecycle: LifecycleState = "new";
  private readonly pendingWaits = new Map<string, AbortController>();
  private readonly workspaceRoot: string;

  constructor(private readonly client: MyClaudeClient, options: McpServerOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ?? process.cwd();
  }

  get lifecycleState(): LifecycleState {
    return this.lifecycle;
  }

  async dispatch(request: unknown): Promise<unknown | undefined> {
    if (isNotification(request)) {
      try {
        await this.handleNotification(notificationSchema.parse(request));
      } catch {
        // JSON-RPC notifications never receive a response, including malformed
        // or unknown notifications.
      }
      return undefined;
    }

    let rpc: z.infer<typeof requestSchema>;
    try {
      rpc = requestSchema.parse(request);
    } catch (error) {
      throw rpcError(-32600, `Invalid MCP request: ${errorMessage(error)}`);
    }

    if (this.lifecycle === "closed") throw rpcError(-32002, "MCP session is closed");
    if (rpc.method === "ping") return success(rpc.id, {});
    if (rpc.method === "initialize") return this.initialize(rpc.id, rpc.params);
    this.requireInitialized();
    if (rpc.method === "tools/list") return success(rpc.id, { tools: MCP_TOOLS });
    if (rpc.method === "tools/call") return this.callTool(rpc.id, rpc.params);
    throw rpcError(-32601, `MCP method not found: ${rpc.method}`);
  }

  close(): void {
    if (this.lifecycle === "closed") return;
    this.lifecycle = "closed";
    for (const controller of this.pendingWaits.values()) controller.abort(new Error("MCP session closed"));
    this.pendingWaits.clear();
  }

  private initialize(id: RpcId, params: unknown): unknown {
    if (this.lifecycle !== "new") throw rpcError(-32600, "MCP session has already been initialized");
    try {
      z.object({
        protocolVersion: z.string().min(1),
        capabilities: z.record(z.string(), z.unknown()),
        clientInfo: z.object({ name: z.string().min(1), version: z.string().min(1) }).passthrough(),
      }).passthrough().parse(params);
    } catch (error) {
      throw rpcError(-32602, `Invalid initialize parameters: ${errorMessage(error)}`);
    }
    this.lifecycle = "awaiting_initialized";
    return success(id, {
      // This server implements one protocol version. Echoing an arbitrary client
      // version falsely claims compatibility, so unsupported requests negotiate
      // back to the version we actually implement.
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "myclaude", version: "0.1.0" },
    });
  }

  private async handleNotification(rpc: z.infer<typeof notificationSchema>): Promise<void> {
    if (rpc.method === "notifications/initialized") {
      if (this.lifecycle !== "awaiting_initialized") return;
      this.lifecycle = "initialized";
      return;
    }
    if (rpc.method === "notifications/cancelled") {
      const params = z.object({ requestId: z.union([z.string(), z.number()]) }).parse(rpc.params);
      this.pendingWaits.get(requestKey(params.requestId))?.abort(new Error("MCP request cancelled"));
    }
    // Unknown notifications are intentionally ignored.
  }

  private requireInitialized(): void {
    if (this.lifecycle !== "initialized") throw rpcError(-32002, "MCP server is not initialized");
  }

  private async callTool(id: RpcId, params: unknown): Promise<unknown | undefined> {
    let call: { name: string; arguments: Record<string, unknown> };
    try {
      call = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).default({}) }).parse(params);
    } catch (error) {
      return toolFailure(id, error);
    }

    if (call.name !== "task_wait") {
      try {
        return toolSuccess(id, await invokeTool(call.name, call.arguments, this.client, this.workspaceRoot));
      } catch (error) {
        return toolFailure(id, error);
      }
    }

    const key = requestKey(id);
    if (this.pendingWaits.has(key)) throw rpcError(-32600, `Duplicate in-flight MCP request id: ${String(id)}`);
    const controller = new AbortController();
    this.pendingWaits.set(key, controller);
    try {
      const invocation = invokeTool(call.name, call.arguments, this.client, this.workspaceRoot, controller.signal).then(
        (value) => ({ kind: "success" as const, value }),
        (error: unknown) => ({ kind: "failure" as const, error }),
      );
      const aborted = new Promise<{ kind: "aborted" }>((resolve) => {
        if (controller.signal.aborted) resolve({ kind: "aborted" });
        else controller.signal.addEventListener("abort", () => resolve({ kind: "aborted" }), { once: true });
      });
      const outcome = await Promise.race([invocation, aborted]);
      if (controller.signal.aborted || outcome.kind === "aborted") return undefined;
      if (outcome.kind === "failure") return toolFailure(id, outcome.error);
      return toolSuccess(id, outcome.value);
    } finally {
      this.pendingWaits.delete(key);
    }
  }
}

/**
 * Compatibility helper for one request. Stateful callers must retain a
 * McpServerSession and call dispatch() on it for the full connection.
 */
export async function dispatchMcpRequest(
  request: unknown,
  client: MyClaudeClient,
  options: McpServerOptions = {},
): Promise<unknown | undefined> {
  return new McpServerSession(client, options).dispatch(request);
}

async function invokeTool(
  name: string,
  args: Record<string, unknown>,
  client: MyClaudeClient,
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<unknown> {
  switch (name) {
    case "task_create": {
      await assertWorkspaceAllowed(z.string().parse(args.workspace), { scopeRoot: workspaceRoot });
      return client.createTask(args as never);
    }
    case "task_submit_plan": {
      const plan = parsePlan(args.plan);
      await assertWorkspaceAllowed(plan.workspace, { scopeRoot: workspaceRoot });
      return client.submitPlan(plan);
    }
    case "task_start": return client.startTask(z.string().uuid().parse(args.taskId));
    case "task_wait": return client.waitTask(
      z.string().uuid().parse(args.taskId),
      z.number().int().min(0).max(300_000).default(30_000).parse(args.timeoutMs),
      { signal },
    );
    case "task_status": return client.getTask(z.string().uuid().parse(args.taskId));
    case "task_list": return client.listTasks();
    case "task_evidence": return client.getEvidence(z.string().uuid().parse(args.taskId));
    case "task_submit_review": {
      const review = args.review as { taskId?: string };
      return client.submitReview(z.string().uuid().parse(review?.taskId), review as never);
    }
    case "task_request_repair": return client.requestRepair(z.string().uuid().parse(args.taskId), z.array(z.string()).default([]).parse(args.instructions));
    case "task_cancel": return client.cancelTask(z.string().uuid().parse(args.taskId));
    default: throw new Error(`MCP tool not found: ${name}`);
  }
}

function success(id: RpcId, result: unknown): unknown {
  return { jsonrpc: "2.0", id, result };
}

function toolSuccess(id: RpcId, result: unknown): unknown {
  return success(id, {
    content: [{ type: "text", text: JSON.stringify(result) ?? "null" }],
    structuredContent: isStructuredContent(result) ? result : { result: result ?? null },
    isError: false,
  });
}

function toolFailure(id: RpcId, error: unknown): unknown {
  const message = errorMessage(error);
  const failure = { error: true, message };
  return success(id, {
    content: [{ type: "text", text: message }],
    structuredContent: failure,
    isError: true,
  });
}

function isNotification(request: unknown): boolean {
  return typeof request === "object"
    && request !== null
    && !Array.isArray(request)
    && !Object.prototype.hasOwnProperty.call(request, "id")
    && typeof (request as { method?: unknown }).method === "string";
}

function requestKey(id: RpcId): string {
  return `${typeof id}:${String(id)}`;
}

function isStructuredContent(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rpcError(code: number, message: string): Error & { rpcCode: number } {
  return Object.assign(new Error(message), { rpcCode: code });
}

function taskIdSchema() {
  return { type: "object", additionalProperties: false, required: ["taskId"], properties: { taskId: { type: "string", format: "uuid" } } } as const;
}
