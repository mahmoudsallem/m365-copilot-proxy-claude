import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import type { MyClaudePlan } from "./schemas.js";
import { redactText } from "./schemas.js";
import { atomicWriteJson, errorMessage } from "./util.js";
import { assertSafeValidationPlan } from "./validation-policy.js";
import { computeWorkspaceFingerprint } from "./fingerprint.js";

export interface ProcessRequest {
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult>;
}

export class NodeProcessRunner implements ProcessRunner {
  constructor(
    private readonly killGraceMs = 2_000,
    private readonly previewBytes = 1_000_000,
    private readonly hardOutputBytes = 16_000_000,
  ) {}

  async run(request: ProcessRequest): Promise<ProcessResult> {
    // Do not create even a short-lived child for work that its caller already
    // cancelled. Besides wasting resources, spawning first opens a race where
    // the child can mutate the workspace before the abort listener is armed.
    if (request.signal?.aborted) request.signal.throwIfAborted();
    const started = Date.now();
    return new Promise<ProcessResult>((resolve, reject) => {
      const child = spawn(request.executable, request.args, {
        cwd: request.cwd,
        env: request.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        // Isolate the worker in its own process group so cancellation also
        // terminates tool subprocesses instead of leaving orphan commands.
        detached: process.platform !== "win32",
      });
      const stdout = new BoundedOutput(this.previewBytes, this.hardOutputBytes);
      const stderr = new BoundedOutput(this.previewBytes, this.hardOutputBytes);
      let settled = false;
      let terminating = false;
      let terminalError: Error | undefined;
      let forceKillTimer: NodeJS.Timeout | undefined;
      const finish = (result: ProcessResult | Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        request.signal?.removeEventListener("abort", abort);
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const killTree = (signal: NodeJS.Signals) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        if (process.platform !== "win32" && child.pid) {
          try {
            process.kill(-child.pid, signal);
            return;
          } catch {
            // Fall back when process groups are unavailable in the host runtime.
          }
        }
        child.kill(signal);
      };
      const abort = () => {
        if (terminating) return;
        terminating = true;
        killTree("SIGTERM");
        forceKillTimer = setTimeout(() => killTree("SIGKILL"), this.killGraceMs);
        forceKillTimer.unref();
      };
      request.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => {
        terminalError = new Error(`process timed out after ${request.timeoutMs}ms: ${request.executable}`);
        abort();
      }, request.timeoutMs);
      timer.unref();
      const collect = (stream: BoundedOutput, label: "stdout" | "stderr", chunk: string) => {
        if (stream.add(chunk) && !terminalError) {
          terminalError = new Error(`process ${label} exceeded ${this.hardOutputBytes} bytes: ${request.executable}`);
          abort();
        }
      };
      child.stdout.setEncoding("utf8").on("data", (chunk) => collect(stdout, "stdout", chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk) => collect(stderr, "stderr", chunk));
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") finish(error);
      });
      child.once("error", (error) => finish(error));
      child.once("close", (code, signal) => finish(terminalError ?? {
        exitCode: code ?? (signal ? 128 : 1),
        stdout: stdout.value(),
        stderr: stderr.value(),
        durationMs: Date.now() - started,
      }));
      if (request.stdin !== undefined) child.stdin.end(request.stdin);
      else child.stdin.end();
      if (request.signal?.aborted) abort();
    });
  }
}

/** Fixed-memory output capture with useful head/tail evidence and a full-stream digest. */
class BoundedOutput {
  private readonly hash = createHash("sha256");
  private readonly half: number;
  private head = "";
  private tail = "";
  private totalBytes = 0;
  private finalized = false;

  constructor(private readonly previewBytes: number, private readonly hardBytes: number) {
    if (previewBytes < 128 || hardBytes < previewBytes) throw new Error("invalid process output limits");
    this.half = Math.floor(previewBytes / 2);
  }

  add(chunk: string): boolean {
    if (this.finalized) return true;
    this.hash.update(chunk);
    this.totalBytes += Buffer.byteLength(chunk);
    let remainder = chunk;
    if (this.head.length < this.half) {
      const capacity = this.half - this.head.length;
      this.head += remainder.slice(0, capacity);
      remainder = remainder.slice(capacity);
    }
    if (remainder) this.tail = `${this.tail}${remainder}`.slice(-this.half);
    return this.totalBytes > this.hardBytes;
  }

  value(): string {
    if (this.finalized) return `${this.head}${this.tail}`;
    this.finalized = true;
    const digest = this.hash.digest("hex");
    const captured = Buffer.byteLength(this.head) + Buffer.byteLength(this.tail);
    if (this.totalBytes <= captured) return `${this.head}${this.tail}`;
    const omitted = Math.max(0, this.totalBytes - captured);
    return `${this.head}\n...[truncated ${omitted} bytes; sha256=${digest}]...\n${this.tail}`;
  }
}

const PROXY_ROUTE_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
  "OPENAI_BASE_URL",
  "M365_PROXY_API_KEY",
];

const PROVIDER_CREDENTIAL_KEYS = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;

/** Clone the environment while preventing planner calls from inheriting proxy credentials/routes. */
export function directPlannerEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = { ...source };
  const proxyKey = source.M365_PROXY_API_KEY;
  for (const key of PROXY_ROUTE_ENV_KEYS) delete clean[key];
  // Preserve genuine direct-provider credentials and enterprise provider flags.
  // Remove only the localhost proxy bearer value when it was copied into a
  // provider variable by a gateway launcher.
  if (proxyKey) {
    for (const key of PROVIDER_CREDENTIAL_KEYS) {
      if (clean[key] === proxyKey) delete clean[key];
    }
  }
  return clean;
}

export function limitedOutput(value: string, limit = 1_000_000): string {
  value = redactText(value);
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n...[truncated ${value.length - limit} characters]`;
}

export interface ExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  turns: number;
  messages: number;
  changedFiles: string[];
  diffLines: number;
  upstreamSignals: Array<"throttle" | "empty-response">;
  sessionId?: string;
  workspaceFingerprintBefore?: string;
  workspaceFingerprintAfter?: string;
  continuations?: number;
  truncated?: boolean;
  checkpointFiles?: string[];
}

export interface ExecutionContext {
  plan: MyClaudePlan;
  phase: "initial" | "repair";
  repairInstructions: string[];
  signal: AbortSignal;
  maxTurns: number;
  maxMessages: number;
  /** Fixed task deadline shared by initial execution, continuations, and repairs. */
  deadlineAt?: string;
  sessionId?: string;
  runDirectory: string;
  resumeSession?: boolean;
}

export interface ExecutorAdapter {
  execute(context: ExecutionContext): Promise<ExecutionResult>;
}

export interface ValidationResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface ValidatorAdapter {
  validate(plan: MyClaudePlan, signal: AbortSignal): Promise<ValidationResult[]>;
}

export class UnavailableExecutor implements ExecutorAdapter {
  async execute(): Promise<ExecutionResult> {
    throw new Error("no MyClaude executor is configured; set MYCLAUDE_EXECUTOR_BIN or inject an ExecutorAdapter");
  }
}

export interface CommandExecutorOptions {
  executable: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  runner?: ProcessRunner;
  supportsSessionResume?: boolean;
}

/** Runs a configured proxy-backed Claude executable. It never substitutes direct Claude. */
export class CommandExecutorAdapter implements ExecutorAdapter {
  private readonly runner: ProcessRunner;
  constructor(private readonly options: CommandExecutorOptions) {
    this.runner = options.runner ?? new NodeProcessRunner();
  }

  async execute(context: ExecutionContext): Promise<ExecutionResult> {
    const initialPrompt = buildExecutionPrompt(context);
    if (!Number.isInteger(context.maxTurns) || context.maxTurns < 1) throw new Error("executor turn budget is exhausted");
    if (!Number.isInteger(context.maxMessages) || context.maxMessages < 1) throw new Error("executor message budget is exhausted");
    const deadlineMs = context.deadlineAt === undefined
      ? Date.now() + context.plan.execution.budgets.timeoutMinutes * 60_000
      : Date.parse(context.deadlineAt);
    if (!Number.isFinite(deadlineMs)) throw new Error("executor deadline is invalid");
    const sessionId = context.sessionId ?? randomUUID();
    const workspaceFingerprintBefore = await safeWorkspaceFingerprint(context.plan.workspace);
    const firstSessionArgs = this.options.supportsSessionResume === false
      ? []
      : context.sessionId && (context.phase === "repair" || context.resumeSession)
        ? ["--resume", context.sessionId]
        : ["--session-id", sessionId];
    const outputs: ProcessResult[] = [];
    const checkpointFiles: string[] = [];
    let continuations = 0;
    let totalTurns = 0;
    let totalMessages = 0;
    let truncated = false;
    let prompt = initialPrompt;
    do {
      let result: ProcessResult;
      try {
        const remainingTurns = Math.min(
          context.maxTurns - totalTurns,
          context.maxMessages - totalMessages,
        );
        const remainingTimeoutMs = deadlineMs - Date.now();
        if (remainingTurns < 1) throw new Error("executor turn or message budget is exhausted");
        if (remainingTimeoutMs <= 0) throw new Error("executor task deadline is exhausted");
        result = await this.runner.run({
          executable: this.options.executable,
          args: [
            ...withMaxTurns(
              this.options.args ?? ["-p", "--output-format", "json", "--permission-mode", context.plan.execution.profile === "host-unrestricted" ? "bypassPermissions" : "acceptEdits"],
              remainingTurns,
            ),
            ...(process.env.MYCLAUDE_HOOK_SETTINGS ? ["--settings", process.env.MYCLAUDE_HOOK_SETTINGS] : []),
            ...(continuations === 0 ? firstSessionArgs : ["--resume", sessionId]),
          ],
          cwd: context.plan.workspace,
          env: {
            ...(this.options.env ?? process.env),
            MYCLAUDE_RUN_DIR: context.runDirectory,
            MYCLAUDE_WORKSPACE: context.plan.workspace,
            MYCLAUDE_EXECUTION_PROFILE: context.plan.execution.profile,
            MYCLAUDE_SESSION_ID: sessionId,
          },
          stdin: prompt,
          timeoutMs: Math.max(1, remainingTimeoutMs),
          signal: context.signal,
        });
      } catch (error) {
        result = { exitCode: context.signal.aborted ? 130 : 1, stdout: "", stderr: errorMessage(error), durationMs: 0 };
      }
      outputs.push(result);
      const currentOutput = `${result.stdout}\n${result.stderr}`;
      const currentTurns = extractCount(currentOutput, "num_turns") || extractCount(currentOutput, "turns");
      const currentMessages = extractCount(currentOutput, "messages") || currentTurns || 1;
      totalTurns += currentTurns;
      totalMessages += currentMessages;
      truncated = result.exitCode === 0 && isTruncatedResponse(currentOutput);
      const canContinue = truncated
        && this.options.supportsSessionResume !== false
        && !context.signal.aborted
        && continuations < 3
        && totalTurns < context.maxTurns
        && totalMessages < context.maxMessages;
      if (!canContinue) break;
      continuations += 1;
      const checkpointFile = join(context.runDirectory, "checkpoints", `executor-continuation-${continuations}.json`);
      await atomicWriteJson(checkpointFile, {
        schemaVersion: "myclaude.executor-checkpoint/v1",
        taskId: context.plan.taskId,
        sessionId,
        continuation: continuations,
        reason: "max-output",
        workspaceFingerprint: await safeWorkspaceFingerprint(context.plan.workspace),
        createdAt: new Date().toISOString(),
      });
      checkpointFiles.push(checkpointFile);
      prompt = [
        "Continue the same task from the current workspace and existing session.",
        "The previous response hit the output limit. Inspect current files and hook evidence, do not redo completed work, and finish the remaining plan steps.",
        "Checkpoint progress after each remaining step and run the immutable validation commands before stopping.",
      ].join("\n");
    } while (true);

    const finalResult = outputs.at(-1)!;
    const combined = outputs.map((entry) => `${entry.stdout}\n${entry.stderr}`).join("\n");
    // Do not reuse the worker's aborted signal: interrupted attempts must still
    // checkpoint their partial workspace changes before recovery.
    const changed = await this.inspectGit(context.plan);
    const workspaceFingerprintAfter = await safeWorkspaceFingerprint(context.plan.workspace);
    return {
      exitCode: finalResult.exitCode,
      stdout: limitedOutput(outputs.map((entry) => entry.stdout).join("\n")),
      stderr: limitedOutput(outputs.map((entry) => entry.stderr).join("\n")),
      turns: totalTurns,
      messages: totalMessages,
      changedFiles: changed.files,
      diffLines: changed.lines,
      upstreamSignals: [
        ...(/throttl/i.test(combined) ? ["throttle" as const] : []),
        ...(/empty response/i.test(combined) ? ["empty-response" as const] : []),
      ],
      sessionId,
      workspaceFingerprintBefore,
      workspaceFingerprintAfter,
      continuations,
      truncated,
      checkpointFiles,
    };
  }

  private async inspectGit(plan: MyClaudePlan): Promise<{ files: string[]; lines: number }> {
    const signal = AbortSignal.timeout(8_000);
    try {
      const names = await this.runner.run({ executable: "git", args: ["diff", "HEAD", "--name-only", "--"], cwd: plan.workspace, timeoutMs: 8_000, signal });
      const stats = await this.runner.run({ executable: "git", args: ["diff", "HEAD", "--numstat", "--"], cwd: plan.workspace, timeoutMs: 8_000, signal });
      const untracked = await this.runner.run({ executable: "git", args: ["ls-files", "--others", "--exclude-standard", "-z"], cwd: plan.workspace, timeoutMs: 8_000, signal });
      if ([names, stats, untracked].some((entry) => entry.exitCode !== 0)) throw new Error("workspace is not a readable Git worktree");
      const untrackedFiles = untracked.stdout.split("\0").map((item) => item.trim()).filter(Boolean);
      let lines = stats.stdout.split("\n").filter(Boolean).reduce((total, line) => {
        const [added, removed] = line.split("\t");
        return total + (Number(added) || 0) + (Number(removed) || 0);
      }, 0);
      for (const file of untrackedFiles) {
        try {
          const content = await readFile(join(plan.workspace, file));
          lines += content.includes(0) ? 1 : countTextLines(content.toString("utf8"));
        } catch {
          // A concurrently removed untracked file remains listed as changed but contributes no lines.
        }
      }
      const trackedFiles = names.stdout.split("\n").map((item) => item.trim()).filter(Boolean);
      return { files: [...new Set([...trackedFiles, ...untrackedFiles])], lines };
    } catch {
      return inspectNonGitWorkspace(plan.workspace);
    }
  }
}

function isTruncatedResponse(output: string): boolean {
  return /"stop_reason"\s*:\s*"max_tokens"/i.test(output)
    || /"stopReason"\s*:\s*"max_tokens"/i.test(output)
    || /\b(?:maximum|max)[ -]?(?:output|token)s?\b.*\b(?:reached|limit|truncat)/i.test(output)
    || /\bresponse (?:was )?truncated\b/i.test(output);
}

async function safeWorkspaceFingerprint(workspace: string): Promise<string | undefined> {
  try {
    return await computeWorkspaceFingerprint(workspace);
  } catch {
    return undefined;
  }
}

async function inspectNonGitWorkspace(root: string): Promise<{ files: string[]; lines: number }> {
  const files: string[] = [];
  let lines = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        files.push(relative(root, path));
        try {
          const content = await readFile(path);
          lines += content.length > 10_000_000 || content.includes(0) ? 1 : countTextLines(content.toString("utf8"));
        } catch {
          // A concurrently removed file is still useful as a changed path.
        }
      }
    }
  };
  try {
    await visit(root);
  } catch {
    return { files: [], lines: 0 };
  }
  return { files: files.sort(), lines };
}

function countTextLines(value: string): number {
  if (!value) return 0;
  const newlines = value.match(/\n/g)?.length ?? 0;
  return newlines + (value.endsWith("\n") ? 0 : 1);
}

export class CommandValidatorAdapter implements ValidatorAdapter {
  private readonly runner: ProcessRunner;
  private readonly sandboxExecutable: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: {
    runner?: ProcessRunner;
    sandboxExecutable?: string;
    env?: NodeJS.ProcessEnv;
  } = {}) {
    this.runner = options.runner ?? new NodeProcessRunner();
    this.sandboxExecutable = options.sandboxExecutable ?? process.env.MYCLAUDE_BWRAP_BIN ?? "/usr/bin/bwrap";
    this.env = options.env ?? process.env;
  }

  async validate(plan: MyClaudePlan, signal: AbortSignal): Promise<ValidationResult[]> {
    const results: ValidationResult[] = [];
    const decisions = assertSafeValidationPlan(plan);
    if (!this.sandboxExecutable.startsWith("/") || !existsSync(this.sandboxExecutable)) {
      throw new Error(`validation sandbox is unavailable: ${this.sandboxExecutable}; install bubblewrap or set MYCLAUDE_BWRAP_BIN to an absolute executable`);
    }
    const snapshot = await createValidationSnapshot(plan.workspace);
    try {
      for (const [index, validation] of plan.validation.commands.entries()) {
        if (signal.aborted) throw new Error("validation cancelled");
        const decision = decisions[index];
        try {
          const result = await this.runner.run({
            executable: this.sandboxExecutable,
            args: validationSandboxArguments(snapshot, decision.executable!, decision.args!, this.env),
            cwd: snapshot,
            env: safeValidationEnvironment(this.env),
            timeoutMs: validation.timeoutMs,
            signal,
          });
          results.push({ ...result, command: validation.command, stdout: limitedOutput(result.stdout), stderr: limitedOutput(result.stderr) });
        } catch (error) {
          results.push({ command: validation.command, exitCode: 1, stdout: "", stderr: errorMessage(error), durationMs: 0 });
        }
      }
    } finally {
      await rm(snapshot, { recursive: true, force: true });
    }
    return results;
  }
}

/** Copy the post-execution tree so validators can write build/test artifacts without mutating it. */
async function createValidationSnapshot(workspace: string): Promise<string> {
  const snapshot = await mkdtemp(join(tmpdir(), "myclaude-validation-"));
  try {
    await cp(workspace, snapshot, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      filter: (source) => {
        const name = basename(source);
        return source === workspace || (name !== ".git" && name !== "node_modules");
      },
    });
    for (const dependencies of await findDependencyDirectories(workspace)) {
      const destination = join(snapshot, relative(workspace, dependencies));
      try {
        await lstat(destination);
      } catch {
        // Dependencies remain read-only through the sandbox's root mount. Build
        // outputs and caches are written only inside the disposable snapshot.
        await symlink(dependencies, destination, "dir");
      }
    }
    return snapshot;
  } catch (error) {
    await rm(snapshot, { recursive: true, force: true });
    throw error;
  }
}

async function findDependencyDirectories(root: string, directory = root, output: string[] = []): Promise<string[]> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === ".git") continue;
    const path = join(directory, entry.name);
    if (entry.name === "node_modules") output.push(path);
    else await findDependencyDirectories(root, path, output);
  }
  return output;
}

/** Keep daemon/proxy/provider credentials and code-injection variables out of validators. */
export function safeValidationEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    PATH: source.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: source.LANG ?? "C.UTF-8",
    LC_ALL: source.LC_ALL ?? "C.UTF-8",
    TZ: source.TZ ?? "UTC",
    CI: "1",
    HOME: "/tmp/myclaude-home",
    TMPDIR: "/tmp",
    XDG_CACHE_HOME: "/tmp/myclaude-cache",
    XDG_CONFIG_HOME: "/tmp/myclaude-config",
    XDG_STATE_HOME: "/tmp/myclaude-state",
  };
}

function validationSandboxArguments(workspace: string, executable: string, args: string[], source: NodeJS.ProcessEnv): string[] {
  const clean = safeValidationEnvironment(source);
  const sandbox = [
    "--die-with-parent", "--new-session", "--unshare-net", "--cap-drop", "ALL",
    "--ro-bind", "/", "/",
    "--tmpfs", "/tmp",
    "--dir", clean.HOME!,
    "--dir", clean.XDG_CACHE_HOME!,
    "--dir", clean.XDG_CONFIG_HOME!,
    "--dir", clean.XDG_STATE_HOME!,
  ];
  for (const candidate of sensitiveValidationPaths(source)) {
    if (!candidate.startsWith("/") || !existsSync(candidate)) continue;
    try {
      const metadata = statSync(candidate);
      if (metadata.isDirectory()) sandbox.push("--tmpfs", candidate);
      else sandbox.push("--bind", "/dev/null", candidate);
    } catch {
      // A concurrently removed credential path needs no mount.
    }
  }
  sandbox.push(
    "--bind", workspace, workspace,
    "--dev", "/dev",
    "--proc", "/proc",
    "--chdir", workspace,
    "--clearenv",
  );
  for (const [key, value] of Object.entries(clean)) {
    if (value !== undefined) sandbox.push("--setenv", key, value);
  }
  sandbox.push("--", executable, ...args);
  return sandbox;
}

function sensitiveValidationPaths(source: NodeJS.ProcessEnv): string[] {
  const home = source.HOME || homedir();
  const state = source.MYCLAUDE_STATE_ROOT || source.M365_STATE_DIR;
  const config = source.M365_CONFIG_DIR;
  return [...new Set([
    state,
    config,
    join(home, ".ssh"), join(home, ".gnupg"), join(home, ".aws"),
    join(home, ".azure"), join(home, ".config"), join(home, ".docker"),
    join(home, ".kube"), join(home, ".codex"), join(home, ".claude"),
    join(home, ".anthropic"), join(home, ".local", "state"),
    join(home, ".local", "share", "keyrings"), join(home, ".password-store"),
    join(home, ".npmrc"), join(home, ".pypirc"), join(home, ".netrc"),
    join(home, ".git-credentials"), join(home, ".authinfo"),
    typeof process.getuid === "function" ? `/run/user/${process.getuid()}` : undefined,
  ].filter((value): value is string => Boolean(value)))];
}

function extractCount(output: string, key: string): number {
  const match = output.match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`, "i"));
  return match ? Number(match[1]) : 0;
}

/** Replace caller-provided limits so every Claude Code invocation is bounded. */
function withMaxTurns(args: string[], maxTurns: number): string[] {
  const bounded: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--max-turns") {
      index += 1;
      continue;
    }
    if (argument.startsWith("--max-turns=")) continue;
    bounded.push(argument);
  }
  return [...bounded, "--max-turns", String(maxTurns)];
}

function buildExecutionPrompt(context: ExecutionContext): string {
  const plan = context.plan;
  const steps = topologicallyOrderedSteps(plan);
  const repair = context.phase === "repair"
    ? `\nRepair instructions:\n${context.repairInstructions.map((item) => `- ${item}`).join("\n")}\n`
    : "";
  return [
    "Execute the following already-approved plan in the current workspace.",
    "Inspect before editing. Preserve unrelated user changes. Do not claim completion; the external orchestrator decides from evidence.",
    `Task: ${plan.objective}`,
    `Constraints:\n${plan.constraints.map((item) => `- ${item}`).join("\n") || "- none"}`,
    `Steps (execute in this dependency order and checkpoint evidence after each step):\n${steps.map((step) => [
      `${step.id}. ${step.title}`,
      `Depends on: ${step.dependencies.join(", ") || "none"}`,
      `Expected files: ${step.expectedFiles.join(", ") || "not constrained"}`,
      step.instructions,
      `Acceptance: ${step.acceptanceCriteria.join("; ")}`,
    ].join("\n")).join("\n\n")}`,
    `Before stopping, run these immutable validation commands so the verification hooks can observe them. The external orchestrator will repeat them independently:\n${plan.validation.commands.map((item) => `- ${item.command}`).join("\n")}`,
    repair,
    `Turn budget: ${context.maxTurns}; message budget: ${context.maxMessages}.`,
  ].join("\n\n");
}

function topologicallyOrderedSteps(plan: MyClaudePlan): MyClaudePlan["steps"] {
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  const emitted = new Set<string>();
  const ordered: MyClaudePlan["steps"] = [];
  while (ordered.length < plan.steps.length) {
    const ready = plan.steps.filter((step) => !emitted.has(step.id) && step.dependencies.every((dependency) => emitted.has(dependency)));
    if (ready.length === 0) throw new Error("plan dependency graph cannot be scheduled");
    for (const step of ready) {
      if (!byId.has(step.id)) continue;
      emitted.add(step.id);
      ordered.push(step);
    }
  }
  return ordered;
}
