import { z } from "zod";
import { MyClaudeClient } from "./client.js";

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

export async function dispatchMcpRequest(request: unknown, client: MyClaudeClient): Promise<unknown> {
  const rpc = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number()]).optional(), method: z.string(), params: z.unknown().optional() }).parse(request);
  if (rpc.method === "notifications/initialized") return undefined;
  if (rpc.method === "ping") return { jsonrpc: "2.0", id: rpc.id, result: {} };
  if (rpc.method === "initialize") {
    const requested = (rpc.params as { protocolVersion?: string } | undefined)?.protocolVersion;
    return { jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: requested ?? "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "myclaude", version: "0.1.0" } } };
  }
  if (rpc.method === "tools/list") return { jsonrpc: "2.0", id: rpc.id, result: { tools: MCP_TOOLS } };
  if (rpc.method !== "tools/call") throw Object.assign(new Error(`MCP method not found: ${rpc.method}`), { rpcCode: -32601 });
  const call = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).default({}) }).parse(rpc.params);
  const result = await invokeTool(call.name, call.arguments, client);
  return {
    jsonrpc: "2.0",
    id: rpc.id,
    result: {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
      isError: false,
    },
  };
}

async function invokeTool(name: string, args: Record<string, unknown>, client: MyClaudeClient): Promise<unknown> {
  switch (name) {
    case "task_create": return client.createTask(args as never);
    case "task_submit_plan": return client.submitPlan(args.plan as never);
    case "task_start": return client.startTask(z.string().uuid().parse(args.taskId));
    case "task_wait": return client.waitTask(z.string().uuid().parse(args.taskId), z.number().int().min(0).max(300_000).default(30_000).parse(args.timeoutMs));
    case "task_status": return client.getTask(z.string().uuid().parse(args.taskId));
    case "task_list": return client.listTasks();
    case "task_evidence": return client.getEvidence(z.string().uuid().parse(args.taskId));
    case "task_submit_review": {
      const review = args.review as { taskId?: string };
      return client.submitReview(z.string().uuid().parse(review?.taskId), review as never);
    }
    case "task_request_repair": return client.requestRepair(z.string().uuid().parse(args.taskId), z.array(z.string()).default([]).parse(args.instructions));
    case "task_cancel": return client.cancelTask(z.string().uuid().parse(args.taskId));
    default: throw Object.assign(new Error(`MCP tool not found: ${name}`), { rpcCode: -32602 });
  }
}

function taskIdSchema() {
  return { type: "object", additionalProperties: false, required: ["taskId"], properties: { taskId: { type: "string", format: "uuid" } } } as const;
}
