import { getTurnStats, toneHealth } from "@m365-copilot/proxy-lib";

/** Ops JSON: tone-health breakers + recent upstream turn latencies. Local-only,
 * mirroring the dashboard guard — this exposes tone outage + failure details. */
export default defineEventHandler((event) => {
  if (!["127.0.0.1", "::1", "localhost"].includes(getRequestIP(event) ?? "")) {
    throw createError({ statusCode: 403, statusMessage: "Local only" });
  }
  return {
    tones: toneHealth.snapshot(),
    turns: getTurnStats(),
  };
});
