import { AnthropicMessagesRequest, handleAnthropicMessages } from "@m365-copilot/proxy-lib";
import { pool } from "../../server-pool";

/** Anthropic Messages compatibility endpoint for Claude Code and Anthropic SDK clients. */
export default defineEventHandler(async (event) => {
  let body: ReturnType<typeof AnthropicMessagesRequest.parse>;
  try {
    body = AnthropicMessagesRequest.parse(await readBody(event));
  } catch (error: any) {
    return new Response(JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: error.message },
    }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const controller = new AbortController();
  const req = event.node?.req;
  const res = event.node?.res;
  if (req && res) {
    let finished = false;
    res.once("finish", () => { finished = true; });
    const abort = () => { if (!finished && !res.writableEnded) controller.abort(); };
    req.once("close", abort);
    res.once("close", abort);
  }

  const systemPromptSpec =
    (event.node?.req?.headers?.["x-m365-system-prompt"] as string | undefined) ?? undefined;
  const sessionKey =
    (event.node?.req?.headers?.["x-m365-session-id"] as string | undefined) ?? undefined;

  try {
    return await handleAnthropicMessages(body, pool, { signal: controller.signal, systemPromptSpec, sessionKey });
  } catch (err: any) {
    console.error("[messages.post error]", err.stack || err);
    throw err;
  }
});
