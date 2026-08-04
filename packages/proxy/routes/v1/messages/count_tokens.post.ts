import { estimateAnthropicInputTokens } from "@m365-copilot/proxy-lib";

/** Claude Code may use this for context planning. This is deliberately an estimate. */
export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  return { input_tokens: estimateAnthropicInputTokens(body) };
});
