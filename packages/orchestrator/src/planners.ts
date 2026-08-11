import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ExecutionEvidence, MyClaudePlan, MyClaudeReview } from "./schemas.js";
import { MyClaudePlanSchema, MyClaudeReviewSchema, parsePlan, parseReview } from "./schemas.js";
import { directPlannerEnvironment, NodeProcessRunner, type ProcessRunner } from "./runner.js";

export interface PlanSeed {
  taskId: string;
  title: string;
  objective: string;
  workspace: string;
  baseFingerprint: string;
  risk?: "low" | "medium" | "high";
  executionProfile?: "guarded" | "host-unrestricted";
}

export interface PlannerResult<T> {
  artifact: T;
  sessionId: string;
}

export interface PlannerAdapter {
  readonly provider: "claude" | "codex";
  createPlan(seed: PlanSeed): Promise<PlannerResult<MyClaudePlan>>;
  review(input: { plan: MyClaudePlan; evidence: ExecutionEvidence; sessionId?: string }): Promise<PlannerResult<MyClaudeReview>>;
}

const planJsonSchema = z.toJSONSchema(MyClaudePlanSchema, { io: "input" });
const reviewJsonSchema = z.toJSONSchema(MyClaudeReviewSchema, { io: "input" });

export class ClaudePlannerAdapter implements PlannerAdapter {
  readonly provider = "claude" as const;
  constructor(
    private readonly runner: ProcessRunner = new NodeProcessRunner(),
    private readonly executable = "claude",
    private readonly model?: string,
  ) {}

  async createPlan(seed: PlanSeed): Promise<PlannerResult<MyClaudePlan>> {
    const sessionId = randomUUID();
    const result = await this.runner.run({
      executable: this.executable,
      args: [
        "-p", "--permission-mode", "plan", "--tools", "Read,Glob,Grep,Bash",
        "--output-format", "json", "--json-schema", JSON.stringify(planJsonSchema),
        "--session-id", sessionId,
        ...(this.model ? ["--model", this.model] : []),
      ],
      cwd: seed.workspace,
      env: directPlannerEnvironment(),
      stdin: planPrompt(seed),
      timeoutMs: 30 * 60_000,
    });
    if (result.exitCode !== 0) throw new Error(`Claude planner failed: ${result.stderr}`);
    const raw = extractClaudeStructuredOutput(result.stdout);
    return { artifact: normalizePlan(raw, seed, { provider: "claude", model: this.model, sessionId }), sessionId };
  }

  async review(input: { plan: MyClaudePlan; evidence: ExecutionEvidence; sessionId?: string }): Promise<PlannerResult<MyClaudeReview>> {
    const sessionId = input.sessionId ?? randomUUID();
    const resume = input.sessionId ? ["--resume", input.sessionId] : ["--session-id", sessionId];
    const result = await this.runner.run({
      executable: this.executable,
      args: [
        "-p", "--permission-mode", "plan", "--tools", "Read,Glob,Grep,Bash",
        "--output-format", "json", "--json-schema", JSON.stringify(reviewJsonSchema),
        ...resume,
        ...(this.model ? ["--model", this.model] : []),
      ],
      cwd: input.plan.workspace,
      env: directPlannerEnvironment(),
      stdin: reviewPrompt(input.plan, input.evidence),
      timeoutMs: 30 * 60_000,
    });
    if (result.exitCode !== 0) throw new Error(`Claude reviewer failed: ${result.stderr}`);
    const raw = extractClaudeStructuredOutput(result.stdout) as Record<string, unknown>;
    return {
      artifact: parseReview({
        ...raw,
        schemaVersion: "myclaude.review/v1",
        taskId: input.plan.taskId,
        reviewer: { provider: "claude", model: this.model, sessionId },
        createdAt: new Date().toISOString(),
      }),
      sessionId,
    };
  }
}

export class CodexPlannerAdapter implements PlannerAdapter {
  readonly provider = "codex" as const;
  constructor(
    private readonly runner: ProcessRunner = new NodeProcessRunner(),
    private readonly executable = "codex",
    private readonly model?: string,
  ) {}

  async createPlan(seed: PlanSeed): Promise<PlannerResult<MyClaudePlan>> {
    const temporary = await mkdtemp(join(tmpdir(), "myclaude-codex-plan-"));
    try {
      const schemaPath = join(temporary, "schema.json");
      const outputPath = join(temporary, "result.json");
      await writeFile(schemaPath, JSON.stringify(planJsonSchema), { mode: 0o600 });
      const result = await this.runner.run({
        executable: this.executable,
        args: ["exec", "--sandbox", "read-only", "-C", seed.workspace, "--output-schema", schemaPath, "--output-last-message", outputPath, "--json", ...(this.model ? ["--model", this.model] : []), "-"],
        cwd: seed.workspace,
        env: directPlannerEnvironment(),
        stdin: planPrompt(seed),
        timeoutMs: 30 * 60_000,
      });
      if (result.exitCode !== 0) throw new Error(`Codex planner failed: ${result.stderr}`);
      const sessionId = extractCodexSessionId(result.stdout) ?? randomUUID();
      const raw = JSON.parse(await readFile(outputPath, "utf8"));
      return { artifact: normalizePlan(raw, seed, { provider: "codex", model: this.model, sessionId }), sessionId };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async review(input: { plan: MyClaudePlan; evidence: ExecutionEvidence; sessionId?: string }): Promise<PlannerResult<MyClaudeReview>> {
    const temporary = await mkdtemp(join(tmpdir(), "myclaude-codex-review-"));
    try {
      const schemaPath = join(temporary, "schema.json");
      const outputPath = join(temporary, "result.json");
      await writeFile(schemaPath, JSON.stringify(reviewJsonSchema), { mode: 0o600 });
      const args = input.sessionId
        ? ["exec", "resume", input.sessionId, "--output-schema", schemaPath, "--output-last-message", outputPath, "--json", ...(this.model ? ["--model", this.model] : []), "-"]
        : ["exec", "--sandbox", "read-only", "-C", input.plan.workspace, "--output-schema", schemaPath, "--output-last-message", outputPath, "--json", ...(this.model ? ["--model", this.model] : []), "-"];
      const result = await this.runner.run({ executable: this.executable, args, cwd: input.plan.workspace, env: directPlannerEnvironment(), stdin: reviewPrompt(input.plan, input.evidence), timeoutMs: 30 * 60_000 });
      if (result.exitCode !== 0) throw new Error(`Codex reviewer failed: ${result.stderr}`);
      const sessionId = extractCodexSessionId(result.stdout) ?? input.sessionId ?? randomUUID();
      const raw = JSON.parse(await readFile(outputPath, "utf8")) as Record<string, unknown>;
      return {
        artifact: parseReview({
          ...raw,
          schemaVersion: "myclaude.review/v1",
          taskId: input.plan.taskId,
          reviewer: { provider: "codex", model: this.model, sessionId },
          createdAt: new Date().toISOString(),
        }),
        sessionId,
      };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

function normalizePlan(raw: unknown, seed: PlanSeed, planner: MyClaudePlan["planner"]): MyClaudePlan {
  const object = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const execution = (object.execution && typeof object.execution === "object" ? object.execution : {}) as Record<string, unknown>;
  return parsePlan({
    ...object,
    schemaVersion: "myclaude.plan/v1",
    taskId: seed.taskId,
    title: seed.title,
    objective: seed.objective,
    workspace: seed.workspace,
    baseFingerprint: seed.baseFingerprint,
    planner,
    risk: seed.risk ?? object.risk ?? "medium",
    execution: { ...execution, profile: seed.executionProfile ?? "guarded" },
    createdAt: new Date().toISOString(),
  });
}

function planPrompt(seed: PlanSeed): string {
  return [
    "Inspect the repository read-only and produce a decision-complete implementation plan matching the supplied JSON schema.",
    "Do not edit files. Do not include secrets. Validation commands must be individual deterministic repo-local commands with no pipes, redirections, chaining, quoting, subshells, network, or output-path flags. Allowed families are pnpm/npm/yarn/bun test|lint|build|typecheck scripts; npx --no-install vitest|jest|eslint|tsc; cargo test|check|clippy; go test; pytest; and dotnet test.",
    `Objective: ${seed.objective}`,
    `Workspace: ${seed.workspace}`,
    `Risk: ${seed.risk ?? "medium"}`,
    `Task ID: ${seed.taskId}`,
  ].join("\n\n");
}

function reviewPrompt(plan: MyClaudePlan, evidence: ExecutionEvidence): string {
  return [
    "Review the implementation against the immutable plan and evidence. Work read-only. Return only the requested structured review.",
    "Approve only when the acceptance criteria and deterministic checks are supported by evidence. Never propose or execute shell commands; give repair instructions as prose.",
    `Plan:\n${JSON.stringify(plan)}`,
    `Evidence:\n${JSON.stringify(evidence)}`,
  ].join("\n\n");
}

function extractClaudeStructuredOutput(stdout: string): unknown {
  const parsed = JSON.parse(stdout) as { structured_output?: unknown; result?: unknown };
  if (parsed.structured_output !== undefined) return parsed.structured_output;
  if (typeof parsed.result === "string") return JSON.parse(parsed.result);
  if (parsed.result !== undefined) return parsed.result;
  return parsed;
}

function extractCodexSessionId(stdout: string): string | undefined {
  for (const line of stdout.split("\n")) {
    try {
      const event = JSON.parse(line) as { type?: string; thread_id?: string; threadId?: string };
      if (event.type === "thread.started") return event.thread_id ?? event.threadId;
    } catch {
      // Non-JSON diagnostics do not invalidate the structured output file.
    }
  }
  return undefined;
}
