import { isDegradationBackoff } from "@m365-copilot/core";
import { pool } from "../server-pool";

/** Liveness + live capacity stats (pool size, turn-gate saturation, throttle backoff). */
export default defineEventHandler(() => ({
  status: "ok",
  fakeMode: process.env.M365_FAKE_MODE === "1",
  conversations: pool.size,
  gate: pool.turnGate.stats(),
  degradedBackoff: isDegradationBackoff(),
}));
