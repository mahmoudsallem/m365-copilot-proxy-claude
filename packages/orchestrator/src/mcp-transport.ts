import type { McpServerSession } from "./mcp-server.js";
import { errorMessage } from "./util.js";

/** Parse and dispatch one newline-delimited MCP stdio message. */
export async function dispatchMcpLine(line: string, session: McpServerSession): Promise<string | undefined> {
  let request: unknown;
  try {
    request = JSON.parse(line);
  } catch (error) {
    return serializeError(null, -32700, `MCP JSON parse error: ${errorMessage(error)}`);
  }

  const notification = isNotification(request);
  const id = requestId(request);
  try {
    const response = await session.dispatch(request);
    return response === undefined ? undefined : JSON.stringify(response);
  } catch (error) {
    if (notification) return undefined;
    return serializeError(id, (error as { rpcCode?: number }).rpcCode ?? -32000, errorMessage(error));
  }
}

function serializeError(id: string | number | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

function isNotification(request: unknown): boolean {
  return typeof request === "object"
    && request !== null
    && !Array.isArray(request)
    && !Object.prototype.hasOwnProperty.call(request, "id")
    && typeof (request as { method?: unknown }).method === "string";
}

function requestId(request: unknown): string | number | null {
  if (typeof request !== "object" || request === null) return null;
  const id = (request as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}
