import { isAbsolute } from "node:path";
import { z } from "zod";

export const TASK_STATES = [
  "draft",
  "planned",
  "queued",
  "executing",
  "validating",
  "reviewing",
  "repairing",
  "passed",
  "partial",
  "blocked",
  "failed",
  "cancelled",
] as const;

export const TaskStateSchema = z.enum(TASK_STATES);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const TERMINAL_TASK_STATES = new Set<TaskState>([
  "passed",
  "partial",
  "blocked",
  "failed",
  "cancelled",
]);

const BudgetSchema = z.object({
  initialTurns: z.number().int().min(1).max(200).default(40),
  repairTurns: z.number().int().min(1).max(100).default(12),
  messages: z.number().int().min(1).max(600).default(80),
  reviewCycles: z.number().int().min(0).max(10).default(2),
  timeoutMinutes: z.number().int().min(1).max(1440).default(90),
});

export const DEFAULT_BUDGETS = Object.freeze({
  initialTurns: 40,
  repairTurns: 12,
  messages: 80,
  reviewCycles: 2,
  timeoutMinutes: 90,
});

const PlanStepSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().min(1).max(300),
  instructions: z.string().min(1).max(50_000),
  dependencies: z.array(z.string().min(1)).default([]),
  expectedFiles: z.array(z.string().min(1)).default([]),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
});

const ValidationCommandSchema = z.object({
  command: z.string().min(1).max(10_000),
  timeoutMs: z.number().int().min(100).max(3_600_000).default(120_000),
});

export const MyClaudePlanSchema = z.object({
  schemaVersion: z.literal("myclaude.plan/v1"),
  taskId: z.string().uuid(),
  title: z.string().min(1).max(300),
  objective: z.string().min(1).max(50_000),
  workspace: z.string().refine(isAbsolute, "workspace must be an absolute path"),
  baseFingerprint: z.string().min(1).max(500),
  planner: z.object({
    provider: z.enum(["claude", "codex", "none"]),
    model: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
  }),
  risk: z.enum(["low", "medium", "high"]).default("medium"),
  assumptions: z.array(z.string().min(1)).default([]),
  constraints: z.array(z.string().min(1)).default([]),
  steps: z.array(PlanStepSchema).min(1),
  validation: z.object({
    commands: z.array(ValidationCommandSchema).min(1),
  }),
  execution: z.object({
    profile: z.enum(["guarded", "host-unrestricted"]).default("guarded"),
    concurrency: z.number().int().min(1).max(4).default(1),
    budgets: BudgetSchema.default(DEFAULT_BUDGETS),
  }),
  review: z.object({
    policy: z.enum(["adaptive", "always", "never"]).default("adaptive"),
    preferredReviewer: z.enum(["claude", "codex"]).optional(),
  }).default({ policy: "adaptive" }),
  createdAt: z.string().datetime(),
}).superRefine((plan, context) => {
  const ids = new Set<string>();
  for (const [index, step] of plan.steps.entries()) {
    if (ids.has(step.id)) {
      context.addIssue({ code: "custom", path: ["steps", index, "id"], message: `duplicate step id: ${step.id}` });
    }
    ids.add(step.id);
  }
  for (const [index, step] of plan.steps.entries()) {
    for (const dependency of step.dependencies) {
      if (!ids.has(dependency)) {
        context.addIssue({ code: "custom", path: ["steps", index, "dependencies"], message: `unknown dependency: ${dependency}` });
      }
      if (dependency === step.id) {
        context.addIssue({ code: "custom", path: ["steps", index, "dependencies"], message: "a step cannot depend on itself" });
      }
    }
  }
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) {
      if (byId.has(dependency) && visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  for (const [index, step] of plan.steps.entries()) {
    if (visit(step.id)) {
      context.addIssue({ code: "custom", path: ["steps", index, "dependencies"], message: "step dependency graph contains a cycle" });
      break;
    }
  }
});

export type MyClaudePlan = z.infer<typeof MyClaudePlanSchema>;

export const MyClaudeReviewSchema = z.object({
  schemaVersion: z.literal("myclaude.review/v1"),
  taskId: z.string().uuid(),
  reviewer: z.object({
    provider: z.enum(["claude", "codex", "human"]),
    model: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
  }),
  verdict: z.enum(["approve", "request_changes", "blocked"]),
  summary: z.string().min(1).max(50_000),
  findings: z.array(z.object({
    severity: z.enum(["info", "warning", "error", "critical"]),
    message: z.string().min(1),
    files: z.array(z.string().min(1)).default([]),
  })).default([]),
  repairInstructions: z.array(z.string().min(1)).default([]),
  createdAt: z.string().datetime(),
});

export type MyClaudeReview = z.infer<typeof MyClaudeReviewSchema>;

export const CreateTaskInputSchema = z.object({
  objective: z.string().min(1).max(50_000),
  workspace: z.string().refine(isAbsolute, "workspace must be an absolute path"),
  title: z.string().min(1).max(300).optional(),
});

export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

export interface TaskRecord {
  id: string;
  title: string;
  objective: string;
  workspace: string;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  planSha256?: string;
  reviewCycles: number;
  repairCycles: number;
  lastError?: string;
  cancellationRequested?: boolean;
}

export interface ExecutionEvidence {
  taskId: string;
  state: TaskState;
  startedAt?: string;
  completedAt?: string;
  executor?: {
    exitCode: number;
    stdout: string;
    stderr: string;
    turns: number;
    messages: number;
    changedFiles: string[];
    upstreamSignals: Array<"throttle" | "empty-response">;
    sessionId?: string;
  };
  executorSessionId?: string;
  validation: Array<{
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
  }>;
  validationPolicy?: Array<{
    command: string;
    allowed: boolean;
    executable?: string;
    args?: string[];
    reasons: string[];
    mode: "enforced";
  }>;
  reviews: MyClaudeReview[];
  unresolvedRisks: string[];
  artifacts?: {
    hookEvidence: string;
    hookState: string;
    verification: string;
  };
}

export interface TaskEvent {
  taskId: string;
  sequence: number;
  timestamp: string;
  type: string;
  data: unknown;
  previousHash: string;
  hash: string;
}

const SENSITIVE_KEY = /(?:api[-_]?key|auth(?:orization)?|password|passwd|secret|token|credential|cookie)/i;
const SENSITIVE_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']?[^\s"',}]{4,}/gi,
  /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|glpat-[A-Za-z0-9_-]{16,})\b/g,
];

/** Reject credentials in durable artifacts before they can reach disk. */
export function assertNoSecrets(value: unknown, path = "$", seen = new WeakSet<object>()): void {
  if (typeof value === "string") {
    if (SENSITIVE_VALUE_PATTERNS.some((pattern) => (pattern.lastIndex = 0, pattern.test(value)))) {
      throw new Error(`credential-shaped value is not allowed in task artifacts: ${path}`);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (seen.has(value as object)) return;
  seen.add(value as object);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`, seen));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) throw new Error(`sensitive field is not allowed in task artifacts: ${path}.${key}`);
    assertNoSecrets(child, `${path}.${key}`, seen);
  }
}

export function redactText(value: string): string {
  let redacted = value;
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}

export function redactArtifact(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return seen.get(value as object);
  if (Array.isArray(value)) {
    const array: unknown[] = [];
    seen.set(value, array);
    for (const child of value) array.push(redactArtifact(child, seen));
    return array;
  }
  const object: Record<string, unknown> = {};
  seen.set(value as object, object);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    object[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactArtifact(child, seen);
  }
  return object;
}

export function parsePlan(value: unknown): MyClaudePlan {
  assertNoSecrets(value);
  return MyClaudePlanSchema.parse(value);
}

export function parseReview(value: unknown): MyClaudeReview {
  assertNoSecrets(value);
  return MyClaudeReviewSchema.parse(value);
}
