#!/usr/bin/env node
// Run N isolated Claude Code agents in PARALLEL against the m365 proxy.
//
//   node scripts/agents-parallel.mjs --agents 3 --task "fix the failing tests" \
//        [--model gpt-5.5] [--workdir /tmp/agents] [--stagger-ms 1500] [--yolo]
//
// Isolation: each agent gets its own working directory (or --worktree to make it
// a real git worktree of $PWD). Safety: agents run with --permission-mode
// acceptEdits by default; pass --yolo for --dangerously-skip-permissions.
//
// Concurrency is SAFE for M365: the proxy's TurnGate bounds inflight turns and
// staggers NEW conversation starts (thread-rate throttle guard), so N clients
// don't stampede the account even if all spawn at once.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { spawnClaude } from "./lib/claude-bin.mjs";

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}
const AGENTS = Number(arg("agents", "3"));
const TASK = arg("task", null) ?? (arg("task-file") ? fs.readFileSync(arg("task-file"), "utf8") : null);
const MODEL = arg("model", process.env.ANTHROPIC_MODEL ?? "gpt-5.5");
const ROOT_DIR = arg("workdir", path.join(os.tmpdir(), `m365-agents-${Date.now()}`));
const STAGGER = Number(arg("stagger-ms", "1500"));
const YOLO = args.includes("--yolo");
const WORKTREE = args.includes("--worktree");

if (!TASK) {
  console.error("give --task \"...\" or --task-file <path>");
  process.exit(2);
}

const PROXY_PORT = process.env.PORT ?? "4141";
const PROXY_URL = process.env.M365_PROXY_URL ?? `http://127.0.0.1:${PROXY_PORT}`;
const API_KEY = process.env.M365_PROXY_API_KEY ?? "";

// Preflight
try {
  const res = await fetch(`${PROXY_URL}/health`);
  if (!res.ok) throw new Error(String(res.status));
} catch (e) {
  console.error(`[agents] no proxy at ${PROXY_URL} (${e.message}). Start it: pnpm dev`);
  process.exit(1);
}

fs.mkdirSync(ROOT_DIR, { recursive: true });
console.log(`[agents] ${AGENTS} agent(s) · model=${MODEL} · workdir=${ROOT_DIR}${WORKTREE ? " (git worktrees)" : ""}`);

const permFlag = YOLO ? "--dangerously-skip-permissions" : "--permission-mode";
const permVal = YOLO ? [] : ["acceptEdits"];

const children = [];
for (let i = 0; i < AGENTS; i++) {
  const name = `agent-${String(i + 1).padStart(2, "0")}`;
  const dir = path.join(ROOT_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  if (WORKTREE) {
    try { execFileSync("git", ["worktree", "add", dir, `-b`, `agents/${name}-${Date.now()}`], { stdio: "pipe" }); }
    catch (e) { console.error(`[agents] worktree failed for ${name}: ${e.message}`); }
  }

  const env = {
    ...process.env,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    ANTHROPIC_BASE_URL: PROXY_URL,
    ANTHROPIC_AUTH_TOKEN: API_KEY || "local",
    ANTHROPIC_MODEL: MODEL,
    ANTHROPIC_SMALL_FAST_MODEL: MODEL,
  };
  delete env.ANTHROPIC_API_KEY;

  const child = spawnClaude(["-p", TASK, "--model", MODEL, permFlag, ...permVal], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  const tag = `\x1b[36m[${name}]\x1b[0m`;
  child.stdout.on("data", (d) => process.stdout.write(`${tag} ${d}`));
  child.stderr.on("data", (d) => process.stdout.write(`\x1b[33m[${name}!]\x1b[0m ${d}`));
  children.push({ name, child });
  console.log(`[agents] spawned ${name}`);
  await new Promise((r) => setTimeout(r, STAGGER));
}

const results = await Promise.all(
  children.map(({ name, child }) => new Promise((resolve) =>
    child.on("exit", (code) => resolve({ name, code })))));
console.log("\n[agents] summary:");
for (const r of results) console.log(`  ${r.name}: exit ${r.code}`);
process.exit(results.every((r) => r.code === 0) ? 0 : 1);
