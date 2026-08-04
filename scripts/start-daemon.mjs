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
  },
});

child.unref();
// Close our copies of the fd so the child owns them exclusively
fs.closeSync(out);
fs.closeSync(err);

fs.writeFileSync(pidFile, String(child.pid));
console.log(`Proxy process started in background (PID ${child.pid}).`);
