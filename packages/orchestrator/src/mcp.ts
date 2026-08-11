#!/usr/bin/env node
import { MyClaudeClient } from "./client.js";
import { dispatchMcpRequest } from "./mcp-server.js";
import { errorMessage } from "./util.js";

const client = new MyClaudeClient();
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  if (buffer.length > 10_000_000) {
    process.stderr.write("MCP message exceeds 10 MB\n");
    process.exitCode = 1;
    process.stdin.pause();
    return;
  }
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) void respond(line);
  }
});

async function respond(line: string): Promise<void> {
  let id: string | number | null = null;
  try {
    const request = JSON.parse(line) as { id?: string | number };
    id = request.id ?? null;
    const response = await dispatchMcpRequest(request, client);
    if (response !== undefined) process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: (error as { rpcCode?: number }).rpcCode ?? -32000, message: errorMessage(error) } })}\n`);
  }
}
