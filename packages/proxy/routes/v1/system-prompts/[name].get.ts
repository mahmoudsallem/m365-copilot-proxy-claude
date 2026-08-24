import { getSystemPromptPayload } from "@m365-copilot/proxy-lib";

/** Full text of one system prompt, addressed by corpus name. */
export default defineEventHandler((event) => {
  const name = getRouterParam(event, "name") ?? "";
  const { status, body } = getSystemPromptPayload(name);
  setResponseStatus(event, status);
  return body;
});
