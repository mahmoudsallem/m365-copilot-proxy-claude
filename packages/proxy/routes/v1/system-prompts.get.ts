import { listSystemPromptsPayload } from "@m365-copilot/proxy-lib";

/** Metadata for every system prompt indexed from the corpus (vendor/system-prompts-leaks). */
export default defineEventHandler(() => listSystemPromptsPayload());
