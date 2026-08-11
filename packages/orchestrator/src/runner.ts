import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { MyClaudePlan } from "./schemas.js";
import { redactText } from "./schemas.js";
import { errorMessage } from "./util.js";

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
  async run(request: ProcessRequest): Promise<ProcessResult> {
    const started = Date.now();
    return new Promise<ProcessResult>((resolve, reject) => {
      const child = spawn(request.executable, request.args, {
        cwd: request.cwd,
        env: request.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (result: ProcessResult | Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", abort);
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const abort = () => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      };
      request.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => {
        abort();
        finish(new Error(`process timed out after ${request.timeoutMs}ms: ${request.executable}`));
      }, request.timeoutMs);
      timer.unref();
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") finish(error);
      });
      child.once("error", (error) => finish(error));
      child.once("close", (code, signal) => finish({
        exitCode: code ?? (signal ? 128 : 1),
        stdout,
        stderr,
        durationMs: Date.now() - started,
      }));
      if (request.stdin !== undefined) child.stdin.end(request.stdin);
      else child.stdin.end();
      if (request.signal?.aborted) abort();
    });
  }
}

const PROXY_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "M365_PROXY_API_KEY",
];

/** Clone the environment while preventing planner calls from inheriting proxy credentials/routes. */
export function directPlannerEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = { ...source };
  for (const key of PROXY_ENV_KEYS) delete clean[key];
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
  runDirectory: string;
  resumeSession?: boolean;
}

export interface ExecutionContext {
  plan: MyClaudePlan;
  phase: "initial" | "repair";
  repairInstructions: string[];
  signal: AbortSignal;
  maxTurns: number;
  maxMessages: number;
  sessionId?: string;
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
    const prompt = buildExecutionPrompt(context);
    const timeoutMs = context.plan.execution.budgets.timeoutMinutes * 60_000;
    const sessionId = context.sessionId ?? randomUUID();
    const sessionArgs = this.options.supportsSessionResume === false
      ? []
      : context.sessionId && (context.phase === "repair" || context.resumeSession)
        ? ["--resume", context.sessionId]
        : ["--session-id", sessionId];
    const result = await this.runner.run({
      executable: this.options.executable,
      args: [
        ...(this.options.args ?? ["-p", "--output-format", "json", "--permission-mode", context.plan.execution.profile === "host-unrestricted" ? "bypassPermissions" : "acceptEdits"]),
        ...(process.env.MYCLAUDE_HOOK_SETTINGS ? ["--settings", process.env.MYCLAUDE_HOOK_SETTINGS] : []),
        ...sessionArgs,
      ],
      cwd: context.plan.workspace,
      env: {
        ...(this.options.env ?? process.env),
        MYCLAUDE_RUN_DIR: context.runDirectory,
        MYCLAUDE_WORKSPACE: context.plan.workspace,
        MYCLAUDE_EXECUTION_PROFILE: context.plan.execution.profile,
      },
      stdin: prompt,
      timeoutMs,
      signal: context.signal,
    });
    const combined = `${result.stdout}\n${result.stderr}`;
    const changed = await this.inspectGit(context.plan, context.signal);
    return {
      exitCode: result.exitCode,
      stdout: limitedOutput(result.stdout),
      stderr: limitedOutput(result.stderr),
      turns: extractCount(combined, "num_turns") || extractCount(combined, "turns"),
      messages: extractCount(combined, "messages"),
      changedFiles: changed.files,
      diffLines: changed.lines,
      upstreamSignals: [
        ...(/throttl/i.test(combined) ? ["throttle" as const] : []),
        ...(/empty response/i.test(combined) ? ["empty-response" as const] : []),
      ],
      sessionId,
    };
  }

  private async inspectGit(plan: MyClaudePlan, signal: AbortSignal): Promise<{ files: string[]; lines: number }> {
    try {
      const names = await this.runner.run({ executable: "git", args: ["diff", "--name-only", "--"], cwd: plan.workspace, timeoutMs: 30_000, signal });
      const stats = await this.runner.run({ executable: "git", args: ["diff", "--numstat", "--"], cwd: plan.workspace, timeoutMs: 30_000, signal });
      const lines = stats.stdout.split("\n").filter(Boolean).reduce((total, line) => {
        const [added, removed] = line.split("\t");
        return total + (Number(added) || 0) + (Number(removed) || 0);
      }, 0);
      return { files: names.stdout.split("\n").map((item) => item.trim()).filter(Boolean), lines };
    } catch {
      return { files: [], lines: 0 };
    }
  }
}

export class CommandValidatorAdapter implements ValidatorAdapter {
  constructor(private readonly runner: ProcessRunner = new NodeProcessRunner()) {}

  async validate(plan: MyClaudePlan, signal: AbortSignal): Promise<ValidationResult[]> {
    const results: ValidationResult[] = [];
    for (const validation of plan.validation.commands) {
      if (signal.aborted) throw new Error("validation cancelled");
      try {
        const result = await this.runner.run({
          executable: "/bin/sh",
          args: ["-lc", validation.command],
          cwd: plan.workspace,
          env: process.env,
          timeoutMs: validation.timeoutMs,
          signal,
        });
        results.push({ ...result, command: validation.command, stdout: limitedOutput(result.stdout), stderr: limitedOutput(result.stderr) });
      } catch (error) {
        results.push({ command: validation.command, exitCode: 1, stdout: "", stderr: errorMessage(error), durationMs: 0 });
      }
    }
    return results;
  }
}

function extractCount(output: string, key: string): number {
  const match = output.match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`, "i"));
  return match ? Number(match[1]) : 0;
}

function buildExecutionPrompt(context: ExecutionContext): string {
  const plan = context.plan;
  const repair = context.phase === "repair"
    ? `\nRepair instructions:\n${context.repairInstructions.map((item) => `- ${item}`).join("\n")}\n`
    : "";
  return [
    "Execute the following already-approved plan in the current workspace.",
    "Inspect before editing. Preserve unrelated user changes. Do not claim completion; the external orchestrator decides from evidence.",
    `Task: ${plan.objective}`,
    `Constraints:\n${plan.constraints.map((item) => `- ${item}`).join("\n") || "- none"}`,
    `Steps:\n${plan.steps.map((step) => `${step.id}. ${step.title}\n${step.instructions}\nAcceptance: ${step.acceptanceCriteria.join("; ")}`).join("\n\n")}`,
    repair,
    `Turn budget: ${context.maxTurns}; message budget: ${context.maxMessages}.`,
  ].join("\n\n");
}
