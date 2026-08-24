#!/usr/bin/env node
// Offline END-TO-END validation — cross-platform (Windows/macOS/Linux).
// Boots the REAL built Nitro server against the scripted FakeTransport backend
// (M365_FAKE_MODE=1) and drives it over HTTP:
//
//   1. /health, /v1/models, /v1/system-prompts discovery
//   2. a complete Anthropic agentic tool loop (tool_use -> local shell exec in a
//      sandbox dir -> tool_result -> final answer), exactly what Claude Code does
//   3. streaming SSE shape check
//   4. optional: a real headless `claude -p` run when RUN_CLAUDE_E2E=1 and a
//      Claude binary is found (full harness incl. MCP/skills config)
//
// No auth to Microsoft, no network, no quota. CI-safe. Replaces e2e-sandbox.sh.
import { spawn, exec } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnClaude, resolveClaudeBin } from "../lib/claude-bin.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = process.env.PORT ?? "4141";
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer m365" };
const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "m365-e2e-"));
let server;

const ok = (msg) => console.log(`\x1b[32m[e2e]\x1b[0m ${msg}`);
const fail = async (msg) => {
  console.error(`\x1b[31m[e2e] FAIL: ${msg}\x1b[0m`);
  await new Promise((r) => { server ? server.once("exit", r) : r(); });
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureBuilt() {
  if (fs.existsSync(path.join(ROOT, "packages/proxy/.output/server/index.mjs"))) return;
  console.log("[e2e] building…");
  const { execFileSync } = await import("node:child_process");
  const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  try {
    execFileSync(pnpmCmd, ["-r", "build"], { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
  } catch {
    execFileSync("corepack", ["pnpm", "-r", "build"], { cwd: ROOT, stdio: "inherit" });
  }
}

async function getJson(pathname) {
  const res = await fetch(`${BASE}${pathname}`, { headers: AUTH });
  if (!res.ok) throw new Error(`${pathname} -> HTTP ${res.status}`);
  return res.json();
}

async function main() {
  await ensureBuilt();

  // Boot the built server in fake mode.
  console.log("[e2e] booting proxy in FAKE mode…");
  server = spawn(process.execPath, [path.join(ROOT, "packages/proxy/.output/server/index.mjs")], {
    env: { ...process.env, M365_FAKE_MODE: "1", PORT },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverLog = [];
  server.stdout.on("data", (d) => serverLog.push(d));
  server.stderr.on("data", (d) => serverLog.push(d));

  let up = false;
  for (let i = 0; i < 40; i++) {
    try { await fetch(`${BASE}/health`, { headers: AUTH }); up = true; break; }
    catch { await sleep(250); }
  }
  if (!up) { console.error(serverLog.join("")); return fail("server never came up"); }

  try {
    // 1 — discovery -----------------------------------------------------------
    const health = await getJson("/health");
    if (health.status !== "ok") throw new Error("health not ok");
    if (!health.fakeMode) throw new Error("expected fakeMode:true");
    const models = await getJson("/v1/models");
    if (!models.data.some((m) => m.id === "claude-sonnet")) throw new Error("models missing claude-sonnet");
    if (!models.data.some((m) => m.m365?.supportsTools)) throw new Error("models missing capability metadata");
    const prompts = await getJson("/v1/system-prompts");
    ok(`discovery ok (${prompts.data.length} prompts indexed)`);

    // 2 — agentic tool loop in a sandbox dir ------------------------------------
    const SBX = path.join(OUT_DIR, "sandbox");
    fs.mkdirSync(SBX, { recursive: true });
    fs.writeFileSync(path.join(SBX, "note.txt"), "hello-from-sandbox\n");

    const BASH_TOOL = {
      name: "bash", description: "Run a shell command",
      input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    };
    const post = (body) => fetch(`${BASE}/v1/messages`, {
      method: "POST", headers: { ...AUTH, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });

    const turn1 = await (await post({
      model: "claude-sonnet", max_tokens: 1024, tools: [BASH_TOOL],
      messages: [{ role: "user", content: "read note.txt" }],
    })).json();
    if (turn1.stop_reason !== "tool_use") throw new Error(`turn1 not tool_use: ${JSON.stringify(turn1).slice(0, 200)}`);
    const cmd = turn1.content[0].input.command;
    if (!cmd) throw new Error("no command extracted from tool_use");

    const output = await new Promise((resolve) =>
      exec(cmd, { cwd: SBX }, (err, stdout) => resolve(String(err?.message ?? "") + String(stdout))));
    ok(`tool_use round-trip ok (cmd=${JSON.stringify(cmd)})`);

    const turn2 = await (await post({
      model: "claude-sonnet", max_tokens: 1024, tools: [BASH_TOOL],
      messages: [
        { role: "user", content: "read note.txt" },
        { role: "assistant", content: [{ type: "tool_use", id: "call_e2e", name: "bash", input: { command: cmd } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_e2e", content: output }] },
      ],
    })).json();
    if (turn2.stop_reason !== "end_turn") throw new Error(`turn2 not end_turn: ${JSON.stringify(turn2).slice(0, 200)}`);
    ok("tool_result -> final answer ok");

    // 3 — streaming shape ---------------------------------------------------------
    const sseRes = await post({ model: "gpt-5.5", max_tokens: 64, stream: true, messages: [{ role: "user", content: "say hi" }] });
    const sse = await sseRes.text();
    for (const expected of ["event: message_start", "event: content_block_delta", "event: message_stop"]) {
      if (!sse.includes(expected)) throw new Error(`streaming missing ${expected}`);
    }
    const deltaCount = sse.split("\n").filter((l) => l === "event: content_block_delta").length;
    if (deltaCount <= 1) throw new Error(`not incremental (${deltaCount} delta events)`);
    ok(`streaming ok (${deltaCount} deltas)`);

    // 4 — optional full harness run ----------------------------------------------
    if (process.env.RUN_CLAUDE_E2E === "1") {
      const bin = resolveClaudeBin();
      if (!bin || bin === "claude") {
        console.log("[e2e] skipping live claude harness (no Claude binary found; set CLAUDE_BIN)");
      } else {
        console.log("[e2e] running headless Claude Code against fake proxy…");
        const claudeLog = path.join(OUT_DIR, "claude.log");
        const exitCode = await new Promise((resolve) => {
          const child = spawnClaude(
            ["-p", "Use the bash tool to run: cat note.txt - then reply with its exact contents.", "--permission-mode", "acceptEdits"],
            { cwd: SBX, stdio: ["ignore", "pipe", "pipe"] },
          );
          const out = [];
          child.stdout.on("data", (d) => out.push(d));
          child.stderr.on("data", (d) => out.push(d));
          child.on("exit", (code) => { fs.writeFileSync(claudeLog, out.join("")); resolve(code); });
        });
        if (exitCode !== 0 || !fs.readFileSync(claudeLog, "utf8").includes("hello-from-sandbox")) {
          throw new Error(`claude harness (log: ${claudeLog})`);
        }
        ok("claude harness loop ok");
      }
    } else {
      console.log("[e2e] skipping live claude harness (set RUN_CLAUDE_E2E=1 + CLAUDE_BIN to enable)");
    }

    ok(`ALL OK (artifacts in ${OUT_DIR})`);
  } catch (err) {
    await fail(err.message);
  } finally {
    server.kill();
  }
}

main().then(() => process.exit(0)).catch(async (e) => { console.error(e); await fail(String(e)); });
