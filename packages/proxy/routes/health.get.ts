import { isDegradationBackoff } from "@m365-copilot/core";
import { pool } from "../server-pool";

/** Liveness + live capacity stats (pool size, turn-gate saturation, throttle backoff). */
export default defineEventHandler(() => ({
  status: "ok",
  service: "m365-copilot-proxy",
  host: process.env.NITRO_HOST ?? process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.NITRO_PORT ?? process.env.PORT ?? 4141),
  anthropic_messages: true,
  anthropic_count_tokens: true,
  streaming: true,
  tool_bridge: true,
  tool_bridge_mode: "prompt-emulated",
  default_model: process.env.M365_DEFAULT_MODEL ?? "gpt-5.5",
  fakeMode: process.env.M365_FAKE_MODE === "1",
  upstream_authenticated: process.env.M365_FAKE_MODE === "1" ? true : null,
  active_sessions: pool.size,
  conversations: pool.size,
  gate: pool.turnGate.stats(),
  degradedBackoff: isDegradationBackoff(),
}));
