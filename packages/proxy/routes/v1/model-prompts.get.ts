import { modelPromptRoutesPayload } from "@m365-copilot/proxy-lib";

/** The live model→system-prompt route table (which leaked corpus prompt each model maps to). */
export default defineEventHandler(() => modelPromptRoutesPayload());
