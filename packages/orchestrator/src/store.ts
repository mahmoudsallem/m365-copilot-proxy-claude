import { randomUUID } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  CreateTaskInputSchema,
  type CreateTaskInput,
  type ExecutionEvidence,
  type MyClaudePlan,
  type MyClaudeReview,
  parsePlan,
  parseReview,
  assertNoSecrets,
  redactArtifact,
  type TaskEvent,
  type TaskRecord,
  type TaskState,
} from "./schemas.js";
import { atomicWriteFile, atomicWriteJson, secureDirectory, sha256, stableStringify } from "./util.js";

const ALLOWED_TRANSITIONS: Record<TaskState, ReadonlySet<TaskState>> = {
  draft: new Set(["planned", "cancelled", "failed"]),
  planned: new Set(["queued", "cancelled", "failed"]),
  queued: new Set(["executing", "cancelled", "failed"]),
  executing: new Set(["repairing", "validating", "partial", "blocked", "failed", "cancelled", "queued"]),
  validating: new Set(["reviewing", "repairing", "passed", "partial", "blocked", "failed", "cancelled", "queued"]),
  reviewing: new Set(["repairing", "passed", "partial", "blocked", "failed", "cancelled", "queued"]),
  repairing: new Set(["validating", "reviewing", "passed", "partial", "blocked", "failed", "cancelled", "queued"]),
  passed: new Set(),
  partial: new Set(["queued", "repairing", "reviewing", "passed", "blocked", "cancelled"]),
  blocked: new Set(["queued", "repairing", "cancelled"]),
  failed: new Set(["queued", "repairing", "reviewing", "passed", "blocked", "cancelled"]),
  cancelled: new Set(),
};

function parseJson<T>(body: string, label: string): T {
  try {
    return JSON.parse(body) as T;
  } catch (error) {
    throw new Error(`invalid ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export class TaskStore {
  readonly stateRoot: string;
  readonly tasksRoot: string;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(stateRoot: string) {
    this.stateRoot = stateRoot;
    this.tasksRoot = join(stateRoot, "tasks");
  }

  async initialize(): Promise<void> {
    await secureDirectory(this.stateRoot);
    await secureDirectory(this.tasksRoot);
  }

  taskDirectory(taskId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(taskId)) throw new Error("invalid task id");
    return join(this.tasksRoot, taskId);
  }

  private async locked<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(taskId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const chained = prior.then(() => current);
    this.locks.set(taskId, chained);
    await prior;
    try {
      return await action();
    } finally {
      release();
      if (this.locks.get(taskId) === chained) this.locks.delete(taskId);
    }
  }

  async createTask(input: CreateTaskInput): Promise<TaskRecord> {
    const parsed = CreateTaskInputSchema.parse(input);
    assertNoSecrets(parsed);
    return this.createTaskWithId(randomUUID(), parsed);
  }

  private async createTaskWithId(id: string, parsed: CreateTaskInput): Promise<TaskRecord> {
    const now = new Date().toISOString();
    const record: TaskRecord = {
      id,
      title: parsed.title ?? parsed.objective.slice(0, 100),
      objective: parsed.objective,
      workspace: parsed.workspace,
      state: "draft",
      createdAt: now,
      updatedAt: now,
      reviewCycles: 0,
      repairCycles: 0,
    };
    await this.initialize();
    await secureDirectory(this.taskDirectory(id));
    await secureDirectory(join(this.taskDirectory(id), "reviews"));
    await atomicWriteJson(join(this.taskDirectory(id), "task.json"), record);
    await atomicWriteJson(join(this.taskDirectory(id), "evidence.json"), this.emptyEvidence(id));
    await this.appendEventUnlocked(id, "task.created", { title: record.title, workspace: record.workspace });
    return record;
  }

  async ensureTaskForPlan(planValue: unknown): Promise<TaskRecord> {
    const plan = parsePlan(planValue);
    try {
      return await this.getTask(plan.taskId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return this.createTaskWithId(plan.taskId, { objective: plan.objective, workspace: plan.workspace, title: plan.title });
  }

  async submitPlan(planValue: unknown): Promise<TaskRecord> {
    const plan = parsePlan(planValue);
    return this.locked(plan.taskId, async () => {
      const record = await this.getTask(plan.taskId);
      if (record.workspace !== plan.workspace) throw new Error("plan workspace does not match task workspace");
      if (record.objective !== plan.objective) throw new Error("plan objective does not match task objective");
      const path = join(this.taskDirectory(plan.taskId), "plan.json");
      const digest = sha256(plan);
      try {
        const existing = parsePlan(parseJson(await readFile(path, "utf8"), "stored plan"));
        if (sha256(existing) !== digest) throw new Error("plan is immutable and a different plan is already stored");
        return record;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await atomicWriteJson(path, plan);
      const updated = await this.updateTaskUnlocked(record, {
        state: "planned",
        planSha256: digest,
      });
      await this.appendEventUnlocked(plan.taskId, "plan.submitted", { sha256: digest });
      return updated;
    });
  }

  async getTask(taskId: string): Promise<TaskRecord> {
    const body = await readFile(join(this.taskDirectory(taskId), "task.json"), "utf8");
    return parseJson<TaskRecord>(body, "task record");
  }

  async getPlan(taskId: string): Promise<MyClaudePlan> {
    const value = parseJson(await readFile(join(this.taskDirectory(taskId), "plan.json"), "utf8"), "plan");
    const plan = parsePlan(value);
    const record = await this.getTask(taskId);
    if (!record.planSha256 || sha256(plan) !== record.planSha256) throw new Error("stored plan failed its immutable SHA-256 check");
    return plan;
  }

  async listTasks(): Promise<TaskRecord[]> {
    await this.initialize();
    const entries = await readdir(this.tasksRoot, { withFileTypes: true });
    const tasks: TaskRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        tasks.push(await this.getTask(entry.name));
      } catch {
        // A partially created/corrupt task is not silently treated as executable.
      }
    }
    return tasks.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async transition(taskId: string, state: TaskState, patch: Partial<TaskRecord> = {}): Promise<TaskRecord> {
    return this.locked(taskId, async () => {
      const current = await this.getTask(taskId);
      if (current.state !== state && !ALLOWED_TRANSITIONS[current.state].has(state)) {
        throw new Error(`invalid task transition: ${current.state} -> ${state}`);
      }
      const updated = await this.updateTaskUnlocked(current, { ...patch, state });
      if (current.state !== state) await this.appendEventUnlocked(taskId, "task.state", { from: current.state, to: state });
      return updated;
    });
  }

  async patchTask(taskId: string, patch: Partial<TaskRecord>): Promise<TaskRecord> {
    return this.locked(taskId, async () => this.updateTaskUnlocked(await this.getTask(taskId), patch));
  }

  private async updateTaskUnlocked(current: TaskRecord, patch: Partial<TaskRecord>): Promise<TaskRecord> {
    const updated = redactArtifact({ ...current, ...patch, id: current.id, updatedAt: new Date().toISOString() }) as TaskRecord;
    await atomicWriteJson(join(this.taskDirectory(current.id), "task.json"), updated);
    return updated;
  }

  async getEvidence(taskId: string): Promise<ExecutionEvidence> {
    const path = join(this.taskDirectory(taskId), "evidence.json");
    return parseJson<ExecutionEvidence>(await readFile(path, "utf8"), "execution evidence");
  }

  async setEvidence(taskId: string, evidence: ExecutionEvidence): Promise<void> {
    if (evidence.taskId !== taskId) throw new Error("evidence task id mismatch");
    await this.locked(taskId, async () => {
      await atomicWriteJson(join(this.taskDirectory(taskId), "evidence.json"), redactArtifact(evidence));
      await this.appendEventUnlocked(taskId, "evidence.updated", { state: evidence.state });
    });
  }

  async addReview(taskId: string, reviewValue: unknown): Promise<MyClaudeReview> {
    const review = parseReview(reviewValue);
    if (review.taskId !== taskId) throw new Error("review task id mismatch");
    return this.locked(taskId, async () => {
      const record = await this.getTask(taskId);
      const nextCycle = record.reviewCycles + 1;
      const path = join(this.taskDirectory(taskId), "reviews", `${String(nextCycle).padStart(3, "0")}.json`);
      try {
        await stat(path);
        throw new Error(`review cycle ${nextCycle} already exists`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await atomicWriteJson(path, review);
      await this.updateTaskUnlocked(record, { reviewCycles: nextCycle });
      const evidence = await this.getEvidence(taskId);
      await atomicWriteJson(join(this.taskDirectory(taskId), "evidence.json"), {
        ...evidence,
        reviews: [...evidence.reviews, review],
      });
      await this.appendEventUnlocked(taskId, "review.submitted", { cycle: nextCycle, verdict: review.verdict });
      return review;
    });
  }

  async appendEvent(taskId: string, type: string, data: unknown): Promise<TaskEvent> {
    return this.locked(taskId, async () => this.appendEventUnlocked(taskId, type, data));
  }

  private async appendEventUnlocked(taskId: string, type: string, data: unknown): Promise<TaskEvent> {
    const events = await this.readEventsUnlocked(taskId);
    const previous = events.at(-1);
    const unsigned = {
      taskId,
      sequence: (previous?.sequence ?? 0) + 1,
      timestamp: new Date().toISOString(),
      type,
      data: redactArtifact(data),
      previousHash: previous?.hash ?? "0".repeat(64),
    };
    const event: TaskEvent = { ...unsigned, hash: sha256(unsigned) };
    const body = `${[...events, event].map((item) => stableStringify(item)).join("\n")}\n`;
    await atomicWriteFile(join(this.taskDirectory(taskId), "events.jsonl"), body);
    return event;
  }

  async readEvents(taskId: string, afterSequence = 0): Promise<TaskEvent[]> {
    return (await this.readEventsUnlocked(taskId)).filter((event) => event.sequence > afterSequence);
  }

  private async readEventsUnlocked(taskId: string): Promise<TaskEvent[]> {
    let body: string;
    try {
      body = await readFile(join(this.taskDirectory(taskId), "events.jsonl"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const events = body.split("\n").filter(Boolean).map((line) => parseJson<TaskEvent>(line, "task event"));
    let previousHash = "0".repeat(64);
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      const { hash, ...unsigned } = event;
      if (event.sequence !== index + 1 || event.previousHash !== previousHash || sha256(unsigned) !== hash) {
        throw new Error(`task event chain is invalid at sequence ${event.sequence}`);
      }
      previousHash = hash;
    }
    return events;
  }

  private emptyEvidence(taskId: string): ExecutionEvidence {
    const directory = this.taskDirectory(taskId);
    return {
      taskId,
      state: "draft",
      validation: [],
      reviews: [],
      unresolvedRisks: [],
      artifacts: {
        hookEvidence: join(directory, "evidence.jsonl"),
        hookState: join(directory, "hook-state.json"),
        verification: join(directory, "verification.json"),
      },
    };
  }

  async writeVerification(taskId: string, validation: ExecutionEvidence["validation"]): Promise<void> {
    const { sha256 } = await import("./util.js");
    await atomicWriteJson(join(this.taskDirectory(taskId), "verification.json"), {
      schema: "myclaude.verification/v1",
      status: validation.every((item) => item.exitCode === 0) ? "passed" : "failed",
      verifiedAt: new Date().toISOString(),
      commands: validation.map((item) => ({ commandHash: sha256(item.command), exitCode: item.exitCode })),
    });
  }
}
