import {
  buildClaudeGatewayModelsPayload,
  buildModelsPayload,
} from "@m365-copilot/proxy-lib";

export default defineEventHandler((event) => (
  getHeader(event, "x-m365-claude-code") === "1"
    ? buildClaudeGatewayModelsPayload()
    : buildModelsPayload()
));
