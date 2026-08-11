#!/usr/bin/env node
import { MyClaudeClient } from "./client.js";
import { McpServerSession } from "./mcp-server.js";
import { dispatchMcpLine } from "./mcp-transport.js";

const client = new MyClaudeClient();
const session = new McpServerSession(client);
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
  const response = await dispatchMcpLine(line, session);
  if (response !== undefined) process.stdout.write(`${response}\n`);
}

process.stdin.once("end", () => session.close());
