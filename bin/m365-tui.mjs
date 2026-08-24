#!/usr/bin/env node
// m365-tui — interactive launcher for the M365 Copilot proxy.
//
//   pnpm tui                      (or)  node bin/m365-tui.mjs
//
// Lets you:
//   - launch Claude Code THROUGH this proxy (any registered model) or the
//     ORIGINAL Anthropic backend, side by side;
//   - pick a model from the live registry (/v1/models);
//   - pick a routed system prompt (/v1/system-prompts, corpus in
//     vendor/system-prompts-leaks — run scripts/fetch-system-prompts.mjs);
//   - fire N isolated Claude Code agents in parallel against the proxy;
//   - live-validate every canonical model (sequential, quota-aware).
//
// MCP servers, skills and plugins are Claude Code CLIENT features: once
// ANTHROPIC_BASE_URL points at the proxy they work unchanged — the proxy
// faithfully round-trips tool_use/tool_result.
import readline, { emitKeypressEvents } from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PROXY_PORT = process.env.PORT ?? "4141";
const PROXY_URL = process.env.M365_PROXY_URL ?? `http://127.0.0.1:${PROXY_PORT}`;
const API_KEY = process.env.M365_PROXY_API_KEY ?? "";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? `${os.homedir()}/.local/bin/claude`;
const STATE_FILE = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "m365-copilot-proxy", "tui.json");

const ANSI = { dim: "\x1b[2m", bold: "\x1b[1m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", reset: "\x1b[0m", clear: "\x1b[2J\x1b[H" };

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

async function proxyGet(pathname) {
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;
  const res = await fetch(`${PROXY_URL}${pathname}`, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function requireProxy() {
  try {
    await proxyGet("/health");
    return true;
  } catch {
    console.error(`${ANSI.red}[tui] no proxy answering at ${PROXY_URL}.${ANSI.reset}`);
    console.error(`Start it first:  ${ANSI.cyan}pnpm dev${ANSI.reset}   (or M365_FAKE_MODE=1 pnpm dev for offline scripted mode)`);
    process.exit(1);
  }
}

// --- minimal arrow-key menu -------------------------------------------------

function menu(title, items, { state } = {}) {
  // items: [{ label, hint?, disabled? }] → returns index (promise)
  return new Promise((resolve) => {
    let sel = 0;
    const draw = () => {
      process.stdout.write(ANSI.clear);
      console.log(`${ANSI.bold}m365-copilot-proxy TUI${ANSI.reset} ${ANSI.dim}· ${title}${ANSI.reset}`);
      if (state) console.log(`${ANSI.dim}${state}${ANSI.reset}`);
      console.log("");
      items.forEach((item, i) => {
        const cursor = i === sel ? `${ANSI.cyan}❯ ` : "  ";
        const label = i === sel ? `${ANSI.bold}${item.label}${ANSI.reset}` : item.label;
        const hint = item.hint ? ` ${ANSI.dim}— ${item.hint}${ANSI.reset}` : "";
        console.log(`${cursor}${label}${hint}`);
      });
      console.log("");
      console.log(`${ANSI.dim}↑/↓ move · Enter select · Esc/q back${ANSI.reset}`);
    };
    const onKey = (str, key) => {
      if (key.name === "up" || key.name === "k") sel = Math.max(0, sel - 1);
      else if (key.name === "down" || key.name === "j") sel = Math.min(items.length - 1, sel + 1);
      else if (key.name === "return" || key.name === "enter") { cleanup(); return resolve(sel); }
      else if (key.name === "escape" || key.name === "q") { cleanup(); return resolve(-1); }
      else return draw();
      draw();
    };
    const cleanup = () => {
      stdin.removeListener("keypress", onKey);
      stdin.setRawMode?.(false);
      stdin.pause();
    };
    const stdin = process.stdin;
    emitKeypressEvents(stdin);
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on("keypress", onKey);
    draw();
  });
}


function ask(question, fallback = "") {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question}${fallback ? ` ${ANSI.dim}[${fallback}]${ANSI.reset}` : ""}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || fallback);
    });
  });
}

// --- actions ----------------------------------------------------------------

async function pickModel(current) {
  const data = (await proxyGet("/v1/models")).data;
  const items = data.map((m) => ({
    label: m.id,
    hint: m.m365 ? `${m.m365.displayName} · ${m.m365.toolMode}` : undefined,
  }));
  const idx = await menu("choose a model", items, { state: `current: ${current ?? "unset"} · ${data.length} models` });
  return idx === -1 ? null : data[idx].id;
}

async function pickSystemPrompt() {
  let prompts = [];
  try { prompts = (await proxyGet("/v1/system-prompts")).data; } catch { /* older proxy */ }
  const items = [
    { label: "(none)", hint: "no injected system prompt" },
    ...(prompts.map((p) => ({ label: p.name, hint: `${p.chars} chars` }))),
  ];
  const idx = await menu("route a system prompt", items, { state: `${prompts.length} indexed · fetch more: pnpm prompts:fetch` });
  if (idx === -1) return undefined;
  return idx === 0 ? null : items[idx].label; // null = explicitly none; string = name
}

function claudeEnv({ model, promptSpec }) {
  const env = {
    ...process.env,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_BUG_COMMAND: "1",
  };
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.CLAUDE_CODE_USE_VERTEX;
  env.ANTHROPIC_BASE_URL = PROXY_URL;
  env.ANTHROPIC_AUTH_TOKEN = API_KEY || "local";
  env.ANTHROPIC_MODEL = model;
  env.ANTHROPIC_SMALL_FAST_MODEL = model;
  if (promptSpec) env.ANTHROPIC_CUSTOM_HEADERS = `x-m365-system-prompt: ${promptSpec}`;
  else delete env.ANTHROPIC_CUSTOM_HEADERS;
  return env;
}

async function launchViaProxy(state) {
  const model = await pickModel(state.model);
  if (!model) return;
  const promptChoice = await pickSystemPrompt();
  if (promptChoice === undefined) return;
  state.model = model;
  state.systemPrompt = promptChoice;
  saveState(state);
  console.log(ANSI.clear);
  console.log(`${ANSI.green}▶ launching Claude Code via ${PROXY_URL}${ANSI.reset}  model=${model}  prompt=${promptChoice ?? "none"}`);
  console.log(`${ANSI.dim}MCP/skills/plugins are client-side — configure them as usual (.mcp.json, ~/.claude).${ANSI.reset}\n`);
  const child = spawn(CLAUDE_BIN, ["--model", model], {
    stdio: "inherit",
    env: claudeEnv({ model, promptSpec: promptChoice }),
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

async function launchOriginal(state) {
  console.log(ANSI.clear);
  console.log(`${ANSI.green}▶ launching ORIGINAL Claude Code (Anthropic backend)${ANSI.reset}`);
  const env = { ...process.env };
  for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_CUSTOM_HEADERS"]) delete env[k];
  const child = spawn(CLAUDE_BIN, [], { stdio: "inherit", env });
  child.on("exit", (code) => process.exit(code ?? 0));
}

async function parallelAgents() {
  const n = Number(await ask("how many agents?", "3"));
  const task = await ask("shared task for every agent");
  if (!task) { console.log("no task given"); return; }
  const rootDir = await ask("workdir root", path.join(os.tmpdir(), `m365-agents-${Date.now()}`));
  const model = await pickModel("gpt-5.5");
  if (!model) return;
  fs.mkdirSync(rootDir, { recursive: true });
  console.log(`${ANSI.dim}spawning ${n} agents (staggered by the proxy's turn gate)…${ANSI.reset}`);
  const children = [];
  for (let i = 0; i < n; i++) {
    const dir = path.join(rootDir, `agent-${String(i + 1).padStart(2, "0")}`);
    fs.mkdirSync(dir, { recursive: true });
    const child = spawn(CLAUDE_BIN, ["-p", task, "--model", model], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      env: claudeEnv({ model, promptSpec: null }),
    });
    child.stdout.on("data", (d) => process.stdout.write(`${ANSI.cyan}[a${i + 1}]${ANSI.reset} ${d}`));
    child.stderr.on("data", (d) => process.stdout.write(`${ANSI.yellow}[a${i + 1}!]${ANSI.reset} ${d}`));
    children.push(child);
    await new Promise((r) => setTimeout(r, 1500)); // gentle stagger on top of server gate
  }
  const codes = await Promise.all(children.map((c) => new Promise((r) => c.on("exit", r))));
  console.log(`\nexit codes: ${codes.join(", ")}`);
}

async function validateModels() {
  const yes = await ask("this burns REAL quota (one turn per model). type 'yes' to continue", "");
  if (yes.toLowerCase() !== "yes") return;
  execFileSync("node", [path.join(ROOT, "scripts", "validate-models.mjs"), "--proxy", PROXY_URL, ...(API_KEY ? ["--key", API_KEY] : [])], { stdio: "inherit" });
}

async function showStatus() {
  const health = await proxyGet("/health");
  const models = (await proxyGet("/v1/models")).data;
  console.log(ANSI.clear);
  console.log(`${ANSI.bold}proxy @ ${PROXY_URL}${ANSI.reset}`);
  console.log(`status: ${health.status}${health.fakeMode ? " (FAKE MODE)" : ""}   conversations: ${health.conversations}   degradedBackoff: ${health.degradedBackoff}`);
  console.log(`gate: ${JSON.stringify(health.gate)}`);
  console.log(`models: ${models.length} registered`);
  const lines = await ask("\nEnter to continue", "");
}

// --- main -------------------------------------------------------------------

const state = loadState();
await requireProxy();

for (;;) {
  const idx = await menu("main", [
    { label: "Claude Code via m365 proxy", hint: "agentic loop, tools/MCP/skills intact" },
    { label: "Original Claude Code", hint: "real Anthropic backend for comparison" },
    { label: "Parallel agents", hint: "N isolated headless runs against the proxy" },
    { label: "Validate all models (LIVE)", hint: "sequential one-turn probe per canonical model" },
    { label: "Proxy status", hint: "pool, turn-gate, throttle stats" },
    { label: "Quit" },
  ], { state: `proxy ${PROXY_URL} · last model: ${state.model ?? "-"}` });

  if (idx === -1 || idx === 5) break;
  if (idx === 0) await launchViaProxy(state);
  else if (idx === 1) await launchOriginal(state);
  else if (idx === 2) await parallelAgents();
  else if (idx === 3) await validateModels();
  else if (idx === 4) await showStatus();
}
console.log("bye");
