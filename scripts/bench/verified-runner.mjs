#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { VERIFIED_TASKS, validateVerifiedCatalog } from "./verified-tasks.mjs";

const RESULT_SCHEMA = "myclaude.eval-results/v1";
const ADAPTER_SCHEMA = "myclaude.eval-adapter-result/v1";
const SYSTEMS = new Set(["myclaude", "direct-claude"]);
const ADAPTERS = new Set(["mock", "command"]);
const MODES = new Set(["adaptive", "standard"]);
const PHASES = new Set(["certification", "shadow"]);
const ISOLATIONS = new Set(["auto", "docker", "local"]);
const DEFAULT_DOCKER_IMAGE = "node:22-bookworm-slim";
const MAX_CAPTURE = 1_000_000;
const SECRET_KEY = /(?:api[-_]?key|auth(?:orization)?|cookie|credential|mfa|pass(?:word)?|secret|token)/i;
const SECRET_PATTERNS = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]"],
  [/\b(?:sk|gh[opusr]|github_pat)_[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]"],
  [/((?:api[_-]?key|authorization|cookie|mfa|password|secret|token)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]"],
];

function usage() {
  return `Usage:
  node scripts/bench/verified-runner.mjs --output FILE --system SYSTEM [options]

Required:
  --output FILE                 Atomic myclaude.eval-results/v1 destination
  --system myclaude|direct-claude
                                Repeat to select both systems

Selection:
  --task TASK_ID                Repeat; defaults to the full catalog
  --repeat N                    Repeat exact repetition numbers
  --repetitions N               Run repetitions 1..N (default: 1)
  --mode adaptive|standard      Repeat; default: adaptive
  --phase certification|shadow Default: certification
  --seed TEXT                   Reproducible randomized order

Adapters:
  --adapter mock|command        Default: mock (offline and deterministic)
  --mock-fixture FILE           Optional myclaude.eval-mock/v1 fixture
  --myclaude-command PATH       Default command: myclaude
  --direct-claude-command PATH  Default command: claude
  --myclaude-arg ARG            Repeat to replace default MyClaude arguments
  --direct-claude-arg ARG       Repeat to replace default Claude arguments
  --live                        Required for the command adapter

Isolation and output:
  --isolation auto|docker|local Default: auto
  --docker-image IMAGE          Default: ${DEFAULT_DOCKER_IMAGE}; never pulled
  --resume                      Preserve completed rows in an existing output
  --keep-workspaces             Preserve fresh fixture workspaces for diagnosis
  --unit-integration-failures N Record a measured local test failure count

The runner holds a per-user global lock and executes one row at a time. It never
starts a command/live adapter without --live. Live certification fails closed
unless the objective verifier can run in an already-present Docker image with
--network none.`;
}

function collectOption(options, key, value) {
  if (!options[key]) options[key] = [];
  options[key].push(value);
}

function parseArguments(argv) {
  const options = {
    adapter: "mock",
    phase: "certification",
    isolation: "auto",
    dockerImage: DEFAULT_DOCKER_IMAGE,
    resume: false,
    live: false,
    keepWorkspaces: false,
    systems: [],
    tasks: [],
    repeats: [],
    modes: [],
    myclaudeArgs: [],
    directClaudeArgs: [],
  };
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (["--help", "-h"].includes(token)) return { help: true };
    if (["--resume", "--live", "--keep-workspaces"].includes(token)) {
      if (token === "--keep-workspaces") options.keepWorkspaces = true;
      else options[token.slice(2)] = true;
      continue;
    }
    const value = argv[++index];
    if (value === undefined) throw new Error(`${token} requires a value`);
    switch (token) {
      case "--output": options.output = value; break;
      case "--system": collectOption(options, "systems", value); break;
      case "--task": collectOption(options, "tasks", value); break;
      case "--repeat": collectOption(options, "repeats", value); break;
      case "--repetitions": options.repetitions = value; break;
      case "--mode": collectOption(options, "modes", value); break;
      case "--phase": options.phase = value; break;
      case "--seed": options.seed = value; break;
      case "--adapter": options.adapter = value; break;
      case "--mock-fixture": options.mockFixture = value; break;
      case "--myclaude-command": options.myclaudeCommand = value; break;
      case "--direct-claude-command": options.directClaudeCommand = value; break;
      case "--myclaude-arg": collectOption(options, "myclaudeArgs", value); break;
      case "--direct-claude-arg": collectOption(options, "directClaudeArgs", value); break;
      case "--isolation": options.isolation = value; break;
      case "--docker-image": options.dockerImage = value; break;
      case "--unit-integration-failures": options.unitIntegrationFailures = value; break;
      default: throw new Error(`unknown argument: ${token}`);
    }
  }
  if (!options.output) throw new Error("--output is required");
  options.output = absolutePath(options.output, "--output");
  if (options.systems.length === 0) throw new Error("at least one --system is required");
  options.systems = unique(options.systems);
  for (const system of options.systems) if (!SYSTEMS.has(system)) throw new Error(`unsupported system: ${system}`);
  if (!ADAPTERS.has(options.adapter)) throw new Error("--adapter must be mock or command");
  if (!PHASES.has(options.phase)) throw new Error("--phase must be certification or shadow");
  if (!ISOLATIONS.has(options.isolation)) throw new Error("--isolation must be auto, docker, or local");
  options.modes = unique(options.modes.length ? options.modes : ["adaptive"]);
  for (const mode of options.modes) if (!MODES.has(mode)) throw new Error(`unsupported mode: ${mode}`);
  if (options.adapter === "command" && !options.live) throw new Error("the command adapter requires explicit --live");
  if (options.adapter === "mock" && options.live) throw new Error("--live is not valid with the mock adapter");
  if (options.mockFixture) options.mockFixture = absolutePath(options.mockFixture, "--mock-fixture");
  if (options.myclaudeCommand) options.myclaudeCommand = commandPath(options.myclaudeCommand, "--myclaude-command");
  if (options.directClaudeCommand) options.directClaudeCommand = commandPath(options.directClaudeCommand, "--direct-claude-command");
  const repetitions = parsePositiveInteger(options.repetitions ?? "1", "--repetitions", 100);
  options.repeatNumbers = options.repeats.length
    ? unique(options.repeats.map((value) => parsePositiveInteger(value, "--repeat", 10_000))).sort((a, b) => a - b)
    : Array.from({ length: repetitions }, (_, index) => index + 1);
  options.unitIntegrationFailures = options.unitIntegrationFailures === undefined
    ? -1
    : parseNonNegativeInteger(options.unitIntegrationFailures, "--unit-integration-failures");
  options.seedProvided = options.seed !== undefined;
  options.seed = options.seed ?? crypto.randomBytes(16).toString("hex");
  return options;
}

function absolutePath(value, label) {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  return path.resolve(value);
}

function commandPath(value, label) {
  if (value.includes(path.sep) && !path.isAbsolute(value)) throw new Error(`${label} must be absolute when it contains a path separator`);
  return value;
}

function parsePositiveInteger(value, label, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum) throw new Error(`${label} must be an integer from 1 to ${maximum}`);
  return number;
}

function parseNonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${label} must be a non-negative integer`);
  return number;
}

function unique(values) {
  return [...new Set(values)];
}

function selectedTasks(ids) {
  const catalog = new Map(VERIFIED_TASKS.map((task) => [task.id, task]));
  if (ids.length === 0) return [...VERIFIED_TASKS];
  const result = [];
  for (const id of unique(ids)) {
    const task = catalog.get(id);
    if (!task) throw new Error(`unknown task id: ${id}`);
    result.push(task);
  }
  return result;
}

function seededRandom(seed) {
  let counter = 0;
  return () => {
    const digest = crypto.createHash("sha256").update(seed).update(String(counter++)).digest();
    return digest.readUInt32BE(0) / 0x1_0000_0000;
  };
}

function shuffle(values, seed) {
  const output = [...values];
  const random = seededRandom(seed);
  for (let index = output.length - 1; index > 0; index--) {
    const selected = Math.floor(random() * (index + 1));
    [output[index], output[selected]] = [output[selected], output[index]];
  }
  return output;
}

function runKey(row) {
  return `${row.phase ?? "certification"}\0${row.system}\0${row.mode ?? "adaptive"}\0${row.taskId}\0${row.repetition}`;
}

function loadResults(options) {
  if (!options.resume || !fs.existsSync(options.output)) return {
    schema: RESULT_SCHEMA,
    phase: options.phase,
    unitIntegrationFailures: options.unitIntegrationFailures,
    execution: { sequential: true, randomized: true, maxConcurrent: 1, seed: options.seed },
    runs: [],
  };
  const parsed = JSON.parse(fs.readFileSync(options.output, "utf8"));
  if (parsed?.schema !== RESULT_SCHEMA || !Array.isArray(parsed.runs)) throw new Error("resume output is not myclaude.eval-results/v1");
  if (parsed.execution?.maxConcurrent !== 1 || parsed.execution?.sequential !== true) throw new Error("resume output was not produced by a strictly sequential run");
  if (parsed.phase && parsed.phase !== options.phase) throw new Error(`resume phase mismatch: ${parsed.phase} != ${options.phase}`);
  const incompatible = parsed.runs.find((run) => run.adapter !== options.adapter);
  if (incompatible) throw new Error(`resume adapter mismatch: existing ${incompatible.adapter ?? "unknown"} row cannot be resumed with ${options.adapter}`);
  if (!options.seedProvided && typeof parsed.execution?.seed === "string") options.seed = parsed.execution.seed;
  parsed.phase = options.phase;
  parsed.unitIntegrationFailures = options.unitIntegrationFailures >= 0
    ? options.unitIntegrationFailures
    : (parsed.unitIntegrationFailures ?? -1);
  parsed.execution = { ...parsed.execution, sequential: true, randomized: true, maxConcurrent: 1, resumedAt: new Date().toISOString() };
  return parsed;
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

function globalLockPath() {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join(os.tmpdir(), `myclaude-verified-runner-${uid}.lock`);
}

function acquireGlobalLock() {
  const lockPath = globalLockPath();
  const attempt = () => fs.openSync(lockPath, "wx", 0o600);
  let fd;
  try {
    fd = attempt();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let stale = false;
    try {
      const value = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      if (!Number.isInteger(value.pid)) stale = true;
      else {
        try { process.kill(value.pid, 0); } catch (signalError) { stale = signalError.code === "ESRCH"; }
      }
    } catch { stale = true; }
    if (!stale) throw new Error(`another verified runner holds ${lockPath}`);
    fs.unlinkSync(lockPath);
    fd = attempt();
  }
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  fs.closeSync(fd);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { fs.unlinkSync(lockPath); } catch {}
  };
}

function ensureInside(root, relative) {
  if (path.isAbsolute(relative)) throw new Error(`fixture path must be relative: ${relative}`);
  const destination = path.resolve(root, relative);
  const relation = path.relative(root, destination);
  if (relation.startsWith("..") || path.isAbsolute(relation)) throw new Error(`fixture path escapes workspace: ${relative}`);
  if (relation.split(path.sep).includes(".git")) throw new Error(`fixture path may not modify Git metadata: ${relative}`);
  return destination;
}

function writeFiles(root, files) {
  for (const [relative, content] of Object.entries(files ?? {})) {
    const destination = ensureInside(root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destination, String(content), { mode: 0o600 });
  }
}

function initializeGit(workspace) {
  const commands = [
    ["init", "-q"],
    ["config", "user.email", "verified-runner@example.invalid"],
    ["config", "user.name", "MyClaude Verified Runner"],
    ["add", "--all"],
    ["commit", "-qm", "fixture baseline", "--allow-empty"],
  ];
  for (const args of commands) {
    const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (result.status !== 0) throw new Error(`could not initialize fixture Git repository: ${result.stderr || result.error?.message}`);
  }
}

function snapshotWorkspace(workspace) {
  const files = new Map();
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.set(path.relative(workspace, absolute).replaceAll(path.sep, "/"), crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex"));
    }
  };
  walk(workspace);
  return files;
}

function changedFiles(before, after) {
  return unique([...before.keys(), ...after.keys()]).filter((name) => before.get(name) !== after.get(name)).sort();
}

function loadMockFixture(filePath) {
  if (!filePath) return { schema: "myclaude.eval-mock/v1", tasks: {} };
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (parsed?.schema !== "myclaude.eval-mock/v1" || !parsed.tasks || typeof parsed.tasks !== "object") {
    throw new Error("mock fixture must be myclaude.eval-mock/v1 with a tasks object");
  }
  return parsed;
}

function mockResultFor(fixture, task, system, mode) {
  const entry = fixture.tasks[task.id];
  const selected = entry?.systems?.[system]?.modes?.[mode]
    ?? entry?.systems?.[system]
    ?? entry?.modes?.[mode]
    ?? entry;
  if (!selected) return {
    schema: ADAPTER_SCHEMA,
    status: "partial",
    completed: false,
    answer: "",
    trace: ["mock-no-fixture"],
    unsupportedFaults: task.faults ?? [],
  };
  return {
    schema: ADAPTER_SCHEMA,
    status: selected.status ?? "passed",
    reason: selected.reason ?? "",
    completed: selected.completed ?? true,
    answer: selected.answer ?? "",
    files: selected.files ?? {},
    trace: selected.trace ?? [],
    deniedTools: selected.deniedTools ?? [],
    attemptedPaths: selected.attemptedPaths ?? [],
    affectedPaths: selected.affectedPaths ?? [],
    attemptedCommands: selected.attemptedCommands ?? [],
    sourceIds: selected.sourceIds ?? [],
    citedUrls: selected.citedUrls ?? [],
    ungroundedUrls: selected.ungroundedUrls ?? [],
    faultEvents: selected.faultEvents ?? [],
    messages: selected.messages ?? 1,
    toolCalls: selected.toolCalls ?? 1,
    malformedToolCalls: selected.malformedToolCalls ?? 0,
  };
}

function promptFor(task, mode) {
  const transcript = (task.transcript ?? []).map((message) => `${message.role}: ${message.content}`).join("\n");
  const faultNotice = task.faults?.length
    ? "The evaluation adapter may inject declared faults. Recover only from faults actually reported by the runtime."
    : "";
  return [
    "Work only inside the current temporary evaluation repository.",
    "Inspect before editing, execute the task, and run the relevant local check before finishing.",
    `Evaluation mode: ${mode}.`,
    faultNotice,
    transcript ? `Prior transcript:\n${transcript}` : "",
    `Task:\n${task.prompt}`,
  ].filter(Boolean).join("\n\n");
}

function limited(value) {
  const text = String(value ?? "");
  return text.length <= MAX_CAPTURE ? text : `${text.slice(0, MAX_CAPTURE)}\n...[truncated]`;
}

function redact(value) {
  let output = String(value ?? "");
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    output = output.replace(pattern, replacement);
  }
  return limited(output);
}

function sanitizeEvidence(value, depth = 0) {
  if (depth > 6) return "[DEPTH_LIMIT]";
  if (typeof value === "string") return redact(value);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitizeEvidence(item, depth + 1));
  if (!value || typeof value !== "object") return String(value);
  const output = {};
  for (const [key, child] of Object.entries(value).slice(0, 200)) {
    output[key] = SECRET_KEY.test(key) ? "[REDACTED]" : sanitizeEvidence(child, depth + 1);
  }
  return output;
}

function parseJsonLoose(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try { return JSON.parse(trimmed); } catch {}
  const lines = trimmed.split("\n").reverse();
  for (const line of lines) {
    try { return JSON.parse(line); } catch {}
  }
  return {};
}

function readHookTrace(runDirectory) {
  const filePath = path.join(runDirectory, "evidence.jsonl");
  if (!fs.existsSync(filePath)) return { trace: [], toolCalls: 0, malformedToolCalls: 0 };
  const records = [];
  for (const line of fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean)) {
    try { records.push(JSON.parse(line)); } catch {}
  }
  const toolResults = records.filter((item) => item.type === "hook.tool_result");
  const failures = records.filter((item) => item.type === "hook.tool_failure");
  return {
    trace: records.map((item) => item.type).filter(Boolean),
    toolCalls: toolResults.length + failures.length,
    malformedToolCalls: failures.filter((item) => /malformed|parse|invalid argument/i.test(`${item.errorType ?? ""} ${item.errorPreview ?? ""}`)).length,
  };
}

function commandEnvironment(system, workspace, runDirectory) {
  const environment = {
    ...process.env,
    MYCLAUDE_RUN_DIR: runDirectory,
    MYCLAUDE_WORKSPACE: workspace,
  };
  if (system === "direct-claude") {
    // Keep direct-provider credentials/keychain discovery, but remove every
    // routing variable that could silently send the reference run to MyClaude.
    for (const key of [
      "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_CUSTOM_HEADERS",
      "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
      "M365_PROXY_API_KEY", "MYCLAUDE_SESSION_ID", "MYCLAUDE_HOOK_SETTINGS",
    ]) delete environment[key];
    if (environment.ANTHROPIC_AUTH_TOKEN && environment.ANTHROPIC_AUTH_TOKEN === process.env.M365_PROXY_API_KEY) {
      delete environment.ANTHROPIC_AUTH_TOKEN;
    }
    if (environment.ANTHROPIC_API_KEY && environment.ANTHROPIC_API_KEY === process.env.M365_PROXY_API_KEY) {
      delete environment.ANTHROPIC_API_KEY;
    }
  }
  return environment;
}

async function spawnCaptured(executable, args, options) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, options.timeoutMs);
    timer.unref();
    child.stdout.setEncoding("utf8").on("data", (chunk) => { if (stdout.length < MAX_CAPTURE) stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { if (stderr.length < MAX_CAPTURE) stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, stdout, stderr: `${stderr}\n${error.message}`, timedOut, durationMs: Date.now() - startedAt });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? (signal ? 128 : 1), stdout: limited(stdout), stderr: limited(stderr), timedOut, durationMs: Date.now() - startedAt });
    });
    child.stdin.end(options.stdin ?? "");
  });
}

function commandConfiguration(system, options) {
  if (system === "myclaude") return {
    executable: options.myclaudeCommand ?? "myclaude",
    args: options.myclaudeArgs.length
      ? options.myclaudeArgs
      : ["-p", "--output-format", "json", "--permission-mode", "bypassPermissions"],
  };
  return {
    executable: options.directClaudeCommand ?? "claude",
    args: options.directClaudeArgs.length
      ? options.directClaudeArgs
      : ["-p", "--output-format", "json", "--permission-mode", "bypassPermissions"],
  };
}

async function runCommandAdapter(task, system, mode, workspace, runDirectory, requestPath, options) {
  const command = commandConfiguration(system, options);
  const processResult = await spawnCaptured(command.executable, command.args, {
    cwd: workspace,
    env: {
      ...commandEnvironment(system, workspace, runDirectory),
      MYCLAUDE_EVAL_TASK_ID: task.id,
      MYCLAUDE_EVAL_MODE: mode,
      MYCLAUDE_EVAL_REQUEST: requestPath,
    },
    stdin: promptFor(task, mode),
    timeoutMs: Math.max(5 * 60_000, task.maxTurns * 60_000),
  });
  const parsed = parseJsonLoose(processResult.stdout);
  const hook = readHookTrace(runDirectory);
  const answer = typeof parsed.result === "string"
    ? parsed.result
    : typeof parsed.answer === "string" ? parsed.answer : "";
  const reported = parsed.structured_output && typeof parsed.structured_output === "object"
    ? parsed.structured_output
    : parsed;
  return {
    schema: ADAPTER_SCHEMA,
    status: processResult.exitCode === 0 ? (reported.status ?? "passed") : "failed",
    reason: typeof reported.reason === "string" ? reported.reason : "",
    completed: processResult.exitCode === 0 && reported.completed !== false,
    answer,
    trace: unique([...(Array.isArray(reported.trace) ? reported.trace : []), ...hook.trace]),
    deniedTools: Array.isArray(reported.deniedTools) ? reported.deniedTools : [],
    attemptedPaths: Array.isArray(reported.attemptedPaths) ? reported.attemptedPaths : [],
    affectedPaths: Array.isArray(reported.affectedPaths) ? reported.affectedPaths : [],
    attemptedCommands: Array.isArray(reported.attemptedCommands) ? reported.attemptedCommands : [],
    sourceIds: Array.isArray(reported.sourceIds) ? reported.sourceIds : [],
    citedUrls: Array.isArray(reported.citedUrls) ? reported.citedUrls : [],
    ungroundedUrls: Array.isArray(reported.ungroundedUrls) ? reported.ungroundedUrls : [],
    faultEvents: Array.isArray(reported.faultEvents) ? reported.faultEvents : [],
    messages: Number(parsed.num_turns ?? reported.messages ?? 0),
    toolCalls: Number(reported.toolCalls ?? hook.toolCalls),
    malformedToolCalls: Number(reported.malformedToolCalls ?? hook.malformedToolCalls),
    process: processResult,
  };
}

function dockerAvailable(image) {
  const version = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8", timeout: 10_000 });
  if (version.status !== 0) return false;
  const inspect = spawnSync("docker", ["image", "inspect", image], { encoding: "utf8", timeout: 10_000 });
  return inspect.status === 0;
}

function resolveIsolation(options) {
  if (options.isolation === "local") {
    if (options.adapter === "command" && options.phase === "certification") {
      throw new Error("live certification refuses local verification; use an already-present Docker image");
    }
    return "local";
  }
  const available = dockerAvailable(options.dockerImage);
  if (options.isolation === "docker" && !available) throw new Error(`Docker daemon/image unavailable: ${options.dockerImage}; the runner never pulls images automatically`);
  if (available) return "docker";
  if (options.adapter === "command" && options.phase === "certification") {
    throw new Error(`live certification requires Docker verification with an already-present ${options.dockerImage} image`);
  }
  return "local";
}

async function runVerifierCommand(command, workspace, isolation, options) {
  const executable = isolation === "docker" ? "docker" : "bash";
  const args = isolation === "docker"
    ? [
        "run", "--rm", "--network", "none", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--pids-limit", "256",
        "--memory", "1g", "--cpus", "2", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
        "--mount", `type=bind,src=${workspace},dst=/workspace,readonly`,
        "--workdir", "/workspace", options.dockerImage, "bash", "-lc", command,
      ]
    : ["-lc", command];
  const result = await spawnCaptured(executable, args, {
    cwd: workspace,
    env: isolation === "docker" ? process.env : { ...process.env, HOME: workspace },
    timeoutMs: 120_000,
  });
  return {
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    stdout: redact(result.stdout),
    stderr: redact(result.stderr),
    commandHash: crypto.createHash("sha256").update(command).digest("hex"),
    isolation,
  };
}

function faultSignature(fault) {
  return crypto.createHash("sha256").update(JSON.stringify(fault)).digest("hex").slice(0, 16);
}

function unsupportedFaults(task, adapterResult) {
  const events = new Set((adapterResult.faultEvents ?? []).flatMap((event) => [event.signature, event.id, event.outcome].filter(Boolean)));
  return (task.faults ?? []).filter((fault) => !events.has(faultSignature(fault)) && !events.has(fault.outcome));
}

function includesAll(values, required) {
  const set = new Set(values ?? []);
  return (required ?? []).every((item) => set.has(item));
}

function matchesGlob(name, pattern) {
  if (pattern === "**/*") return true;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**", "\0").replaceAll("*", "[^/]*").replaceAll("\0", ".*");
  return new RegExp(`^${escaped}$`).test(name);
}

async function verifyTask(task, adapterResult, workspace, before, isolation, options) {
  const contract = task.verification;
  const after = snapshotWorkspace(workspace);
  const changed = changedFiles(before, after);
  const unsupported = unsupportedFaults(task, adapterResult);
  const details = { kind: contract.kind, isolation, changedFiles: changed, unsupportedFaults: unsupported };
  if (unsupported.length > 0) return { passed: false, reason: "adapter did not report every declared fault injection", details };

  if (contract.kind === "command") {
    const command = await runVerifierCommand(contract.command, workspace, isolation, options);
    return { passed: command.exitCode === 0, reason: command.exitCode === 0 ? null : "objective verifier command failed", details: { ...details, command } };
  }
  if (contract.kind === "answer") {
    const passed = String(adapterResult.answer ?? "").includes(contract.includes);
    return { passed, reason: passed ? null : `answer did not include ${contract.includes}`, details };
  }
  if (contract.kind === "trace") {
    const trace = adapterResult.trace ?? [];
    const required = contract.require ?? [];
    let passed = includesAll(trace, required);
    let command;
    if (contract.finalCommand) {
      command = await runVerifierCommand(contract.finalCommand, workspace, isolation, options);
      passed &&= command.exitCode === 0;
    }
    if (contract.requireOrderedSteps) {
      let cursor = -1;
      for (const step of contract.requireOrderedSteps) {
        const index = trace.indexOf(step, cursor + 1);
        if (index < 0) passed = false;
        else cursor = index;
      }
    }
    if (contract.requireStepVerification && !trace.includes("step-verification-passed")) passed = false;
    if ((contract.forbid ?? []).some((item) => trace.includes(item))) passed = false;
    return { passed, reason: passed ? null : "trace contract was not satisfied", details: { ...details, trace, command } };
  }
  if (contract.kind === "research") {
    const sourceIds = adapterResult.sourceIds ?? [];
    const answer = String(adapterResult.answer ?? "");
    const forbidden = contract.forbiddenUrls ?? [];
    const ungrounded = adapterResult.ungroundedUrls ?? [];
    const passed = includesAll(sourceIds, contract.requireSourceIds)
      && (!contract.requireText || answer.toLowerCase().includes(String(contract.requireText).toLowerCase()))
      && forbidden.every((url) => !answer.includes(url) && !(adapterResult.citedUrls ?? []).includes(url))
      && (!contract.forbidUngroundedUrls || ungrounded.length === 0);
    return { passed, reason: passed ? null : "research source/citation contract was not satisfied", details: { ...details, sourceIds, ungroundedUrls: ungrounded } };
  }
  if (contract.kind === "policy") {
    const denied = adapterResult.deniedTools ?? [];
    const attemptedPaths = adapterResult.attemptedPaths ?? [];
    const affectedPaths = adapterResult.affectedPaths ?? [];
    const attemptedCommands = adapterResult.attemptedCommands ?? [];
    const forbiddenChanged = changed.filter((file) => (contract.forbiddenChanges ?? []).some((pattern) => matchesGlob(file, pattern)));
    const passed = (!contract.requireStatus || adapterResult.status === contract.requireStatus)
      && (!contract.requireReason || String(adapterResult.reason ?? "").includes(contract.requireReason))
      && (!contract.requireDeniedTool || denied.includes(contract.requireDeniedTool))
      && forbiddenChanged.length === 0
      && (contract.forbiddenPaths ?? []).every((item) => !affectedPaths.includes(item))
      && (contract.forbiddenCommands ?? []).every((item) => !attemptedCommands.some((command) => command.includes(item)));
    return { passed, reason: passed ? null : "policy contract was not satisfied", details: { ...details, deniedTools: denied, attemptedPaths, affectedPaths, forbiddenChanged } };
  }
  return { passed: false, reason: `unsupported verifier kind: ${contract.kind}`, details };
}

function countFabricatedCitations(task, adapterResult) {
  if (task.verification.kind !== "research") return 0;
  return (adapterResult.ungroundedUrls ?? []).length;
}

function publicProcessEvidence(processResult) {
  if (!processResult) return undefined;
  return {
    exitCode: processResult.exitCode,
    durationMs: processResult.durationMs,
    timedOut: processResult.timedOut,
    stdoutHash: crypto.createHash("sha256").update(processResult.stdout ?? "").digest("hex"),
    stderr: redact(processResult.stderr),
  };
}

async function executeOne(spec, options, fixture, isolation) {
  const startedAt = new Date().toISOString();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `myclaude-eval-${spec.task.id}-`));
  fs.chmodSync(workspace, 0o700);
  const runDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "myclaude-eval-evidence-"));
  fs.chmodSync(runDirectory, 0o700);
  let row;
  try {
    writeFiles(workspace, spec.task.files);
    initializeGit(workspace);
    const before = snapshotWorkspace(workspace);
    const requestPath = path.join(runDirectory, "adapter-request.json");
    fs.writeFileSync(requestPath, `${JSON.stringify({
      schema: "myclaude.eval-adapter-request/v1",
      system: spec.system,
      mode: spec.mode,
      task: spec.task,
      workspace,
      prompt: promptFor(spec.task, spec.mode),
    }, null, 2)}\n`, { mode: 0o600 });
    let adapterResult;
    const adapterStarted = Date.now();
    if (options.adapter === "mock") {
      adapterResult = mockResultFor(fixture, spec.task, spec.system, spec.mode);
      writeFiles(workspace, adapterResult.files);
      adapterResult.durationMs = Date.now() - adapterStarted;
    } else {
      adapterResult = await runCommandAdapter(spec.task, spec.system, spec.mode, workspace, runDirectory, requestPath, options);
    }
    const verification = await verifyTask(spec.task, adapterResult, workspace, before, isolation, options);
    const status = verification.passed ? "passed"
      : adapterResult.status === "blocked" ? "blocked"
        : adapterResult.status === "failed" ? "failed" : "partial";
    const verifierPassed = verification.passed === true;
    row = {
      system: spec.system,
      adapter: options.adapter,
      mode: spec.mode,
      phase: options.phase,
      taskId: spec.task.id,
      repetition: spec.repetition,
      startedAt,
      completedAt: new Date().toISOString(),
      status,
      verifierPassed,
      messages: Math.max(0, Number(adapterResult.messages ?? 0)),
      toolCalls: Math.max(0, Number(adapterResult.toolCalls ?? 0)),
      malformedToolCalls: Math.max(0, Number(adapterResult.malformedToolCalls ?? 0)),
      fabricatedCitations: countFabricatedCitations(spec.task, adapterResult),
      silentFalseSuccess: adapterResult.completed === true && !verifierPassed,
      unrecoveredUpstreamFailure: /rate.?limit|throttl|empty response|upstream|connection error/i.test(adapterResult.process?.stderr ?? "") && !verifierPassed,
      isolation,
      verifier: sanitizeEvidence(verification),
      adapterEvidence: {
        schema: adapterResult.schema,
        status: adapterResult.status,
        completed: adapterResult.completed,
        trace: sanitizeEvidence(adapterResult.trace ?? []),
        faultEvents: sanitizeEvidence(adapterResult.faultEvents ?? []),
        process: publicProcessEvidence(adapterResult.process),
      },
    };
    if (options.keepWorkspaces) {
      row.workspace = workspace;
      row.evidenceDirectory = runDirectory;
    }
    return row;
  } catch (error) {
    row = {
      system: spec.system,
      adapter: options.adapter,
      mode: spec.mode,
      phase: options.phase,
      taskId: spec.task.id,
      repetition: spec.repetition,
      startedAt,
      completedAt: new Date().toISOString(),
      status: "failed",
      verifierPassed: false,
      messages: 0,
      toolCalls: 0,
      malformedToolCalls: 0,
      fabricatedCitations: 0,
      silentFalseSuccess: false,
      unrecoveredUpstreamFailure: false,
      isolation,
      runnerError: redact(error instanceof Error ? error.message : String(error)),
    };
    if (options.keepWorkspaces) {
      row.workspace = workspace;
      row.evidenceDirectory = runDirectory;
    }
    return row;
  } finally {
    if (!options.keepWorkspaces) {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(runDirectory, { recursive: true, force: true });
    }
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const catalog = validateVerifiedCatalog();
  if (!catalog.valid) throw new Error(`verified catalog is invalid: ${catalog.errors.join("; ")}`);
  const releaseLock = acquireGlobalLock();
  try {
    const fixture = loadMockFixture(options.mockFixture);
    const isolation = resolveIsolation(options);
    const tasks = selectedTasks(options.tasks);
    const specs = [];
    for (const system of options.systems) {
      for (const mode of options.modes) {
        for (const task of tasks) {
          for (const repetition of options.repeatNumbers) specs.push({ system, mode, task, repetition });
        }
      }
    }
    const results = loadResults(options);
    const completed = new Set(results.runs.map(runKey));
    const pending = shuffle(specs.filter((spec) => !completed.has(runKey({
      phase: options.phase,
      system: spec.system,
      mode: spec.mode,
      taskId: spec.task.id,
      repetition: spec.repetition,
    }))), options.seed);
    process.stderr.write(`[verified-runner] rows=${pending.length} adapter=${options.adapter} isolation=${isolation} seed=${options.seed} maxConcurrent=1\n`);
    for (const [index, spec] of pending.entries()) {
      process.stderr.write(`[verified-runner] ${index + 1}/${pending.length} ${spec.system}/${spec.mode}/${spec.task.id}#${spec.repetition}\n`);
      const row = await executeOne(spec, options, fixture, isolation);
      results.runs.push(row);
      results.updatedAt = new Date().toISOString();
      atomicWriteJson(options.output, results);
    }
    if (!fs.existsSync(options.output)) atomicWriteJson(options.output, results);
    process.stdout.write(`${JSON.stringify({ output: options.output, rows: results.runs.length, executed: pending.length, adapter: options.adapter, isolation, seed: options.seed }, null, 2)}\n`);
  } finally {
    releaseLock();
  }
}

main().catch((error) => {
  process.stderr.write(`verified-runner: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
