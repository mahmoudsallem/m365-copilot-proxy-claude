import { randomUUID } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
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

const MAX_RECONCILED_TASKS = 10_000;
const FINALIZATION_JOURNAL = "finalization.pending.json";

type FinalExecutionState = Extract<TaskState, "passed" | "partial" | "blocked" | "failed" | "cancelled" | "reviewing">;

interface FinalizationJournal {
  schema: "myclaude.finalization/v1";
  operationId: string;
  taskId: string;
  fromState: TaskState;
  state: FinalExecutionState;
  evidence: ExecutionEvidence;
  lastError?: string;
  createdAt: string;
}

interface StoredReview {
  cycle: number;
  review: MyClaudeReview;
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

  /**
   * Repair bounded, well-defined crash windows before the scheduler inspects
   * task state. Artifact files and pending journals are the durable intent;
   * task/evidence/event projections are rebuilt idempotently from them.
   */
  async reconcile(maxTasks = MAX_RECONCILED_TASKS): Promise<void> {
    if (!Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > MAX_RECONCILED_TASKS) {
      throw new Error(`reconciliation task limit must be between 1 and ${MAX_RECONCILED_TASKS}`);
    }
    await this.initialize();
    const entries = (await readdir(this.tasksRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^[0-9a-f-]{36}$/i.test(entry.name));
    if (entries.length > maxTasks) {
      throw new Error(`reconciliation refused ${entries.length} tasks because the limit is ${maxTasks}`);
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      await this.locked(entry.name, async () => this.reconcileTaskUnlocked(entry.name));
    }
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
        return this.reconcilePlanUnlocked(record);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await atomicWriteJson(path, plan);
      return this.reconcilePlanUnlocked(record);
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
      const stored = await this.readStoredReviewsUnlocked(taskId);
      const reviewDigest = sha256(review);
      const duplicate = stored.find((item) => sha256(item.review) === reviewDigest);
      if (duplicate) {
        await this.reconcileReviewsUnlocked(taskId, record, stored);
        return duplicate.review;
      }
      if (record.reviewCycles > stored.length) {
        throw new Error(`task review counter ${record.reviewCycles} exceeds ${stored.length} durable review artifacts`);
      }
      const nextCycle = stored.length + 1;
      const path = join(this.taskDirectory(taskId), "reviews", `${String(nextCycle).padStart(3, "0")}.json`);
      await atomicWriteJson(path, review);
      await this.reconcileReviewsUnlocked(taskId, record, [...stored, { cycle: nextCycle, review }]);
      return review;
    });
  }

  /**
   * Durably finalize one execution attempt. The pending journal is written
   * first, so startup reconciliation can finish every projection after a crash.
   */
  async finalizeExecution(
    taskId: string,
    state: FinalExecutionState,
    evidenceValue: ExecutionEvidence,
    lastError?: string,
  ): Promise<TaskRecord> {
    if (evidenceValue.taskId !== taskId) throw new Error("evidence task id mismatch");
    return this.locked(taskId, async () => {
      const current = await this.getTask(taskId);
      const operationId = finalizationOperationId(taskId, state, evidenceValue);
      const events = await this.readEventsUnlocked(taskId);
      const journalPath = join(this.taskDirectory(taskId), FINALIZATION_JOURNAL);
      const existing = await this.readFinalizationJournal(journalPath, taskId);
      if (events.some((event) => event.type === "execution.completed"
        && (event.data as { operationId?: string }).operationId === operationId)) {
        if (existing && existing.operationId !== operationId) {
          throw new Error(`pending execution finalization ${existing.operationId} conflicts with completed ${operationId}`);
        }
        if (existing) await rm(journalPath, { force: true });
        return current;
      }

      const completedAt = evidenceValue.completedAt ?? new Date().toISOString();
      const journal: FinalizationJournal = existing ?? {
        schema: "myclaude.finalization/v1",
        operationId,
        taskId,
        fromState: current.state,
        state,
        evidence: redactArtifact({ ...evidenceValue, taskId, state, completedAt }) as ExecutionEvidence,
        lastError: lastError === undefined ? undefined : String(redactArtifact(lastError)),
        createdAt: completedAt,
      };
      if (journal.operationId !== operationId) {
        throw new Error(`pending execution finalization ${journal.operationId} conflicts with ${operationId}`);
      }
      if (!existing) await atomicWriteJson(journalPath, journal);
      const updated = await this.applyFinalizationUnlocked(journal);
      await rm(journalPath, { force: true });
      return updated;
    });
  }

  private async reconcileTaskUnlocked(taskId: string): Promise<void> {
    let record: TaskRecord;
    try {
      record = await this.getTask(taskId);
    } catch (error) {
      // A crash before task.json was atomically renamed leaves no authoritative
      // task intent. Preserve the directory for inspection but do not invent it.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await secureDirectory(join(this.taskDirectory(taskId), "reviews"));
    try {
      await this.getEvidence(taskId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (record.state !== "draft") {
        throw new Error(`task ${taskId} is ${record.state} but its execution evidence is missing`);
      }
      await atomicWriteJson(join(this.taskDirectory(taskId), "evidence.json"), this.emptyEvidence(taskId));
    }
    await this.ensureEventUnlocked(
      taskId,
      (event) => event.type === "task.created",
      "task.created",
      { title: record.title, workspace: record.workspace, recovered: true },
    );
    record = await this.reconcilePlanUnlocked(record);
    const reviews = await this.readStoredReviewsUnlocked(taskId);
    await this.reconcileReviewsUnlocked(taskId, record, reviews);

    const journalPath = join(this.taskDirectory(taskId), FINALIZATION_JOURNAL);
    const journal = await this.readFinalizationJournal(journalPath, taskId);
    if (journal) {
      await this.applyFinalizationUnlocked(journal);
      await rm(journalPath, { force: true });
    }
  }

  private async reconcilePlanUnlocked(record: TaskRecord): Promise<TaskRecord> {
    const path = join(this.taskDirectory(record.id), "plan.json");
    let plan: MyClaudePlan;
    try {
      plan = parsePlan(parseJson(await readFile(path, "utf8"), "stored plan"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return record;
      throw error;
    }
    if (plan.taskId !== record.id) throw new Error("stored plan task id does not match task record");
    if (plan.workspace !== record.workspace) throw new Error("stored plan workspace does not match task record");
    if (plan.objective !== record.objective) throw new Error("stored plan objective does not match task record");
    const digest = sha256(plan);
    if (record.planSha256 && record.planSha256 !== digest) {
      throw new Error("stored plan failed its immutable SHA-256 check");
    }
    const state = record.state === "draft" ? "planned" : record.state;
    const updated = record.planSha256 === digest && record.state === state
      ? record
      : await this.updateTaskUnlocked(record, { planSha256: digest, state });
    await this.ensureEventUnlocked(
      record.id,
      (event) => event.type === "plan.submitted"
        && (event.data as { sha256?: string }).sha256 === digest,
      "plan.submitted",
      { sha256: digest, recovered: true },
    );
    return updated;
  }

  private async readStoredReviewsUnlocked(taskId: string): Promise<StoredReview[]> {
    const directory = join(this.taskDirectory(taskId), "reviews");
    await secureDirectory(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    const numbered = entries
      .filter((entry) => entry.isFile() && /^\d{3}\.json$/.test(entry.name))
      .map((entry) => ({ cycle: Number.parseInt(entry.name.slice(0, 3), 10), name: entry.name }))
      .sort((left, right) => left.cycle - right.cycle);
    const reviews: StoredReview[] = [];
    for (const [index, entry] of numbered.entries()) {
      const expectedCycle = index + 1;
      if (entry.cycle !== expectedCycle) {
        throw new Error(`review artifacts are not contiguous: expected cycle ${expectedCycle}, found ${entry.cycle}`);
      }
      const review = parseReview(parseJson(await readFile(join(directory, entry.name), "utf8"), `review cycle ${entry.cycle}`));
      if (review.taskId !== taskId) throw new Error(`review cycle ${entry.cycle} task id mismatch`);
      reviews.push({ cycle: entry.cycle, review });
    }
    return reviews;
  }

  private async reconcileReviewsUnlocked(taskId: string, record: TaskRecord, reviews: StoredReview[]): Promise<void> {
    if (record.reviewCycles > reviews.length) {
      throw new Error(`task review counter ${record.reviewCycles} exceeds ${reviews.length} durable review artifacts`);
    }
    const events = await this.readEventsUnlocked(taskId);
    for (const item of reviews) {
      const digest = sha256(item.review);
      const existing = events.find((event) => event.type === "review.submitted"
        && (event.data as { cycle?: number }).cycle === item.cycle);
      if (!existing) continue;
      const data = existing.data as { verdict?: string; sha256?: string };
      if ((data.sha256 && data.sha256 !== digest) || (data.verdict && data.verdict !== item.review.verdict)) {
        throw new Error(`review cycle ${item.cycle} does not match its hash-chained event`);
      }
    }
    if (record.reviewCycles !== reviews.length) {
      await this.updateTaskUnlocked(record, { reviewCycles: reviews.length });
    }
    const evidence = await this.getEvidence(taskId);
    const durableReviews = reviews.map((item) => item.review);
    if (sha256(evidence.reviews) !== sha256(durableReviews)) {
      await atomicWriteJson(join(this.taskDirectory(taskId), "evidence.json"), redactArtifact({
        ...evidence,
        reviews: durableReviews,
      }));
    }
    for (const item of reviews) {
      const digest = sha256(item.review);
      await this.ensureEventUnlocked(
        taskId,
        (event) => event.type === "review.submitted"
          && (event.data as { cycle?: number }).cycle === item.cycle,
        "review.submitted",
        { cycle: item.cycle, verdict: item.review.verdict, sha256: digest, recovered: true },
      );
    }
  }

  private async readFinalizationJournal(path: string, expectedTaskId: string): Promise<FinalizationJournal | undefined> {
    let value: FinalizationJournal;
    try {
      value = parseJson(await readFile(path, "utf8"), "pending execution finalization");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (value.schema !== "myclaude.finalization/v1"
      || typeof value.operationId !== "string"
      || typeof value.taskId !== "string"
      || value.taskId !== expectedTaskId
      || !Object.hasOwn(ALLOWED_TRANSITIONS, value.fromState)
      || !new Set<FinalExecutionState>(["passed", "partial", "blocked", "failed", "cancelled", "reviewing"]).has(value.state)
      || !value.evidence || value.evidence.taskId !== value.taskId
      || typeof value.createdAt !== "string"
      || value.operationId !== finalizationOperationId(value.taskId, value.state, value.evidence)) {
      throw new Error("pending execution finalization is invalid");
    }
    return value;
  }

  private async applyFinalizationUnlocked(journal: FinalizationJournal): Promise<TaskRecord> {
    const current = await this.getTask(journal.taskId);
    if (current.state !== journal.state && !ALLOWED_TRANSITIONS[current.state].has(journal.state)) {
      throw new Error(`cannot reconcile execution finalization: ${current.state} -> ${journal.state}`);
    }
    const evidence = redactArtifact({
      ...journal.evidence,
      taskId: journal.taskId,
      state: journal.state,
      completedAt: journal.evidence.completedAt ?? journal.createdAt,
    }) as ExecutionEvidence;
    await atomicWriteJson(join(this.taskDirectory(journal.taskId), "evidence.json"), evidence);
    await this.ensureEventUnlocked(
      journal.taskId,
      (event) => event.type === "evidence.updated"
        && (event.data as { operationId?: string }).operationId === journal.operationId,
      "evidence.updated",
      { state: journal.state, operationId: journal.operationId },
    );
    const updated = await this.updateTaskUnlocked(current, { state: journal.state, lastError: journal.lastError });
    if (journal.fromState !== journal.state) {
      await this.ensureEventUnlocked(
        journal.taskId,
        (event) => event.type === "task.state"
          && (event.data as { operationId?: string }).operationId === journal.operationId,
        "task.state",
        { from: journal.fromState, to: journal.state, operationId: journal.operationId },
      );
    }
    await this.ensureEventUnlocked(
      journal.taskId,
      (event) => event.type === "execution.completed"
        && (event.data as { operationId?: string }).operationId === journal.operationId,
      "execution.completed",
      { state: journal.state, operationId: journal.operationId },
    );
    return updated;
  }

  private async ensureEventUnlocked(
    taskId: string,
    predicate: (event: TaskEvent) => boolean,
    type: string,
    data: unknown,
  ): Promise<TaskEvent> {
    const existing = (await this.readEventsUnlocked(taskId)).find(predicate);
    return existing ?? this.appendEventUnlocked(taskId, type, data);
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

  async writeVerification(
    taskId: string,
    declared: MyClaudePlan["validation"]["commands"],
    validation: ExecutionEvidence["validation"],
  ): Promise<void> {
    const assessment = assessValidationEvidence(declared, validation);
    if (!assessment.passed) {
      throw new Error(`refusing to write passed verification: ${assessment.issues.join("; ")}`);
    }
    await atomicWriteJson(join(this.taskDirectory(taskId), "verification.json"), {
      schema: "myclaude.verification/v1",
      status: "passed",
      verifiedAt: new Date().toISOString(),
      commands: validation.map((item) => ({ commandHash: sha256(item.command), exitCode: item.exitCode })),
    });
  }

  async invalidateVerification(taskId: string, issues: string[]): Promise<void> {
    await atomicWriteJson(join(this.taskDirectory(taskId), "verification.json"), {
      schema: "myclaude.verification/v1",
      status: "failed",
      verifiedAt: new Date().toISOString(),
      issues: redactArtifact(issues.map((issue) => String(issue).slice(0, 1_000))),
      commands: [],
    });
  }
}

export interface ValidationEvidenceAssessment {
  passed: boolean;
  issues: string[];
}

function finalizationOperationId(taskId: string, state: FinalExecutionState, evidence: ExecutionEvidence): string {
  const fallbackAttempt = sha256(redactArtifact({
    ...evidence,
    state: undefined,
    completedAt: undefined,
  }));
  return sha256({
    kind: "execution.finalization",
    taskId,
    state,
    attemptId: evidence.attemptId ?? fallbackAttempt,
    planSha256: evidence.planSha256,
  });
}

/** Exact validation contract: count, order, command identity, and exit status. */
export function assessValidationEvidence(
  declared: MyClaudePlan["validation"]["commands"],
  actual: ExecutionEvidence["validation"],
): ValidationEvidenceAssessment {
  const issues: string[] = [];
  if (actual.length !== declared.length) {
    issues.push(`validation result count mismatch: expected ${declared.length}, received ${actual.length}`);
  }
  for (let index = 0; index < declared.length; index += 1) {
    const expected = declared[index];
    const result = actual[index];
    if (!result) {
      issues.push(`validation result ${index + 1} is missing for ${JSON.stringify(expected.command)}`);
      continue;
    }
    if (result.command !== expected.command) {
      issues.push(`validation result ${index + 1} command mismatch: expected ${JSON.stringify(expected.command)}, received ${JSON.stringify(result.command)}`);
    }
    if (!Number.isInteger(result.exitCode) || result.exitCode !== 0) {
      issues.push(`validation result ${index + 1} did not exit successfully`);
    }
  }
  if (actual.length > declared.length) {
    for (let index = declared.length; index < actual.length; index += 1) {
      issues.push(`unexpected validation result ${index + 1}: ${JSON.stringify(actual[index]?.command ?? "unknown")}`);
    }
  }
  return { passed: issues.length === 0, issues };
}
