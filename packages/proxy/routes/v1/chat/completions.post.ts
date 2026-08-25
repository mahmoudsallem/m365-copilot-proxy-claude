import { ChatCompletionRequest, handleChatCompletion, isProfileName, listProfileNames } from "@m365-copilot/proxy-lib";
import { pool } from "../../../server-pool";

export default defineEventHandler(async (event) => {
  let body: ReturnType<typeof ChatCompletionRequest.parse>;
  try {
    body = ChatCompletionRequest.parse(await readBody(event));
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: { message: err.message, type: "invalid_request_error" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Propagate client disconnects as an AbortSignal so a long M365 turn gets
  // cancelled (Stop frame) instead of running on after the caller gave up.
  // Only abort on a *premature* close — guard with the response "finish" event
  // so a normal keep-alive socket close after a completed response is ignored.
  const ac = new AbortController();
  const req = event.node?.req;
  const res = event.node?.res;
  if (req && res) {
    let finished = false;
    res.once("finish", () => { finished = true; });
    const maybeAbort = () => { if (!finished && !res.writableEnded) ac.abort(); };
    req.once("close", maybeAbort);
    res.once("close", maybeAbort);
  }

  // handleChatCompletion returns a Web Response (JSON or an SSE ReadableStream
  // when stream:true). Returning it directly lets h3 forward it untouched.
  const systemPromptSpec =
    (event.node?.req?.headers?.["x-m365-system-prompt"] as string | undefined) ?? undefined;
  const sessionKey =
    (event.node?.req?.headers?.["x-m365-session-id"] as string | undefined) ?? undefined;
  const profileHeader =
    (event.node?.req?.headers?.["x-m365-profile"] as string | undefined)?.trim().toLowerCase() ?? undefined;
  if (profileHeader && !isProfileName(profileHeader)) {
    return new Response(
      JSON.stringify({
        error: {
          message: `Unknown harness profile "${profileHeader}". Supported profiles: ${listProfileNames().join(", ")}`,
          type: "invalid_request_error",
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  return handleChatCompletion(body, pool, { signal: ac.signal, systemPromptSpec, sessionKey, profile: profileHeader });
});
