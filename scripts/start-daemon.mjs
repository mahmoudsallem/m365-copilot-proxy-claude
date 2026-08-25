import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const stateDir = path.join(os.homedir(), ".local", "state", "m365-copilot-proxy");
fs.mkdirSync(stateDir, { recursive: true });

// Append mode so we don't lose previous logs across restarts
const logFile = path.join(stateDir, "proxy.log");
const errFile = path.join(stateDir, "proxy.err.log");
const pidFile = path.join(stateDir, "proxy.pid");

const out = fs.openSync(logFile, "a");
const err = fs.openSync(errFile, "a");

const script = resolve(repoRoot, "packages", "proxy", "bin", "m365-proxy.mjs");

const child = spawn(process.execPath, [script], {
  detached: true,
  windowsHide: true,
  stdio: ["ignore", out, err],
  cwd: repoRoot,
  env: {
    ...process.env,
    M365_PROXY_API_KEY: "m365",
    M365_REQUIRE_API_KEY: "1",
    HOST: "127.0.0.1",
    NITRO_HOST: "127.0.0.1",
    PORT: "4141",
    NODE_NO_WARNINGS: "1",
    // Lean toolset for harness clients (M365 ignores tool framing on large
    // payloads). Core coding tools + web pair stay advertised; everything else
    // becomes a DEFERRED catalog reachable via the synthetic ToolSearch tool.
    // Override by pre-setting the var. M365_MAX_TOOLS caps the advertised count.
    M365_ALLOWED_TOOLS: process.env.M365_ALLOWED_TOOLS ?? "Bash,Read,Edit,Write,Glob,Grep,WebSearch,WebFetch",
    // M365_ALLOW_MULTI_TOOL=1 restores batched calls (opt-in: premature-success
    // risk). M365_NO_TONE_FAILOVER=1 disables upstream tone failover.
    // Latency: stagger between NEW conversation starts (throttle guard — the
    // degradation backoff is the real sustained-burst protection, so this can
    // stay tight) and the quick-retry sleep for empty turns.
    M365_CONVERSATION_START_GAP_MS: process.env.M365_CONVERSATION_START_GAP_MS ?? "1000",
    M365_EMPTY_RETRY_DELAY_MS: process.env.M365_EMPTY_RETRY_DELAY_MS ?? "1000",
    // Claude Code-grade system framing by default (role/environment/protocol).
    // Override with e.g. "baseline" for the legacy shell-first control.
    M365_FRAMING_VARIANT: process.env.M365_FRAMING_VARIANT ?? "claude-code",
    // Inject each requested model family's real system prompt (leak corpus).
    M365_MODEL_PROMPTS: process.env.M365_MODEL_PROMPTS ?? "1",
  },
});

child.unref();
// Close our copies of the fd so the child owns them exclusively
fs.closeSync(out);
fs.closeSync(err);

fs.writeFileSync(pidFile, String(child.pid));
console.log(`Proxy process started in background (PID ${child.pid}).`);
