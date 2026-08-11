import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { ExecutionEvidence, MyClaudePlan, MyClaudeReview, TaskRecord } from "./schemas.js";
import { TERMINAL_TASK_STATES } from "./schemas.js";
import type { ExecutorAdapter, ValidatorAdapter } from "./runner.js";
import { errorMessage } from "./util.js";
import { TaskStore } from "./store.js";
import { computeWorkspaceFingerprint } from "./fingerprint.js";
import { assertSafeValidationPlan, evaluatePlanValidation } from "./validation-policy.js";

export interface SchedulerOptions {
  concurrency?: number;
  executionProfile?: "guarded" | "host-unrestricted";
}

export class TaskScheduler extends EventEmitter {
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private readonly active = new Map<string, AbortController>();
  private configuredConcurrency: number;
  private effectiveConcurrency: number;
  private paused = false;
  private degraded = false;
  private readonly executionProfile: "guarded" | "host-unrestricted";

  constructor(
    readonly store: TaskStore,
    private readonly executor: ExecutorAdapter,
    private readonly validator: ValidatorAdapter,
    options: SchedulerOptions = {},
  ) {
    super();
    this.configuredConcurrency = clampConcurrency(options.concurrency ?? 1);
    this.effectiveConcurrency = this.configuredConcurrency;
    this.executionProfile = options.executionProfile ?? "guarded";
  }

  status() {
    return {
      paused: this.paused,
      queued: [...this.queue],
      active: [...this.active.keys()],
      configuredConcurrency: this.configuredConcurrency,
      effectiveConcurrency: this.effectiveConcurrency,
      degraded: this.degraded,
      executionProfile: this.executionProfile,
    };
  }

  async recover(): Promise<void> {
    for (const task of await this.store.listTasks()) {
      if (["queued", "executing", "validating", "repairing"].includes(task.state)) {
        if (task.state !== "queued") await this.store.transition(task.id, "queued", { lastError: "recovered after orchestrator restart" });
        await this.store.appendEvent(task.id, "task.recovered", { previousState: task.state });
        this.push(task.id);
      }
    }
    this.pump();
  }

  async enqueue(taskId: string): Promise<TaskRecord> {
    const current = await this.store.getTask(taskId);
    if (!current.planSha256) throw new Error("task has no immutable plan");
    const plan = await this.store.getPlan(taskId);
    if (plan.execution.profile !== this.executionProfile) {
      throw new Error(`plan execution profile ${plan.execution.profile} is not allowed by daemon policy ${this.executionProfile}`);
    }
    const validationPolicy = evaluatePlanValidation(plan);
    await this.store.appendEvent(taskId, "validation.policy", { profile: this.executionProfile, decisions: validationPolicy });
    assertSafeValidationPlan(plan);
    const priorEvents = await this.store.readEvents(taskId);
    if (!priorEvents.some((event) => event.type === "execution.started")) {
      const currentFingerprint = await computeWorkspaceFingerprint(plan.workspace);
      if (currentFingerprint !== plan.baseFingerprint) {
        throw new Error(`stale plan: workspace fingerprint changed (planned ${plan.baseFingerprint}, current ${currentFingerprint})`);
      }
    }
    const queued = current.state === "queued" ? current : await this.store.transition(taskId, "queued", { cancellationRequested: false, lastError: undefined });
    this.push(taskId);
    this.pump();
    return queued;
  }

  async cancel(taskId: string): Promise<TaskRecord> {
    this.queued.delete(taskId);
    const index = this.queue.indexOf(taskId);
    if (index >= 0) this.queue.splice(index, 1);
    this.active.get(taskId)?.abort();
    const current = await this.store.getTask(taskId);
    if (TERMINAL_TASK_STATES.has(current.state)) return current;
    const cancelled = await this.store.transition(taskId, "cancelled", { cancellationRequested: true });
    const evidence = await this.store.getEvidence(taskId);
    await this.store.setEvidence(taskId, { ...evidence, state: "cancelled", completedAt: new Date().toISOString(), unresolvedRisks: [...evidence.unresolvedRisks, "execution cancelled"] });
    await this.store.appendEvent(taskId, "task.cancelled", {});
    return cancelled;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.pump();
  }

  setConcurrency(value: number): void {
    this.configuredConcurrency = clampConcurrency(value);
    this.effectiveConcurrency = this.degraded ? 1 : this.configuredConcurrency;
    this.pump();
  }

  reportUpstreamSignal(signal: "throttle" | "empty-response"): void {
    if (this.effectiveConcurrency !== 1) {
      this.degraded = true;
      this.effectiveConcurrency = 1;
      this.emit("degraded", signal);
    }
  }

  async shutdown(timeoutMs = 10_000): Promise<void> {
    this.pause();
    const taskIds = [...new Set([...this.queue, ...this.active.keys()])];
    await Promise.all(taskIds.map((taskId) => this.cancel(taskId)));
    const deadline = Date.now() + timeoutMs;
    while (this.active.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (this.active.size > 0) {
      throw new Error(`scheduler shutdown timed out with active tasks: ${[...this.active.keys()].join(", ")}`);
    }
  }

  async applyReview(taskId: string, review: MyClaudeReview): Promise<TaskRecord> {
    const current = await this.store.getTask(taskId);
    const plan = await this.store.getPlan(taskId);
    if (!["reviewing", "partial", "failed"].includes(current.state)) {
      throw new Error(`reviews are not accepted while task is ${current.state}`);
    }
    if (review.verdict === "approve") {
      if (current.state !== "reviewing") {
        throw new Error(`approval rejected: task is ${current.state}, not reviewing`);
      }
      const evidence = await this.store.getEvidence(taskId);
      if (evidence.state !== "reviewing" || !hasCompleteSuccessfulEvidence(plan, evidence)) {
        throw new Error("approval rejected: current execution and every declared validation command must have fresh successful evidence");
      }
    }
    await this.store.addReview(taskId, review);
    const reviewed = await this.store.getTask(taskId);
    if (review.verdict === "approve") {
      await this.setEvidenceState(taskId, "passed");
      return this.store.transition(taskId, "passed", { lastError: undefined });
    }
    if (review.verdict === "blocked") {
      await this.setEvidenceState(taskId, "blocked", review.summary);
      return this.store.transition(taskId, "blocked", { lastError: review.summary });
    }
    if (reviewed.repairCycles >= plan.execution.budgets.reviewCycles) {
      await this.setEvidenceState(taskId, "blocked", "review repair-cycle budget exhausted");
      return this.store.transition(taskId, "blocked", { lastError: "review repair-cycle budget exhausted" });
    }
    await this.store.appendEvent(taskId, "repair.requested", { instructions: review.repairInstructions, source: "review" });
    await this.store.patchTask(taskId, { repairCycles: reviewed.repairCycles + 1 });
    await this.store.transition(taskId, "repairing");
    return this.enqueue(taskId);
  }

  async requestRepair(taskId: string, instructions: string[] = []): Promise<TaskRecord> {
    const task = await this.store.getTask(taskId);
    const plan = await this.store.getPlan(taskId);
    if (task.repairCycles >= plan.execution.budgets.reviewCycles) {
      await this.setEvidenceState(taskId, "blocked", "repair-cycle budget exhausted");
      return this.store.transition(taskId, "blocked", { lastError: "repair-cycle budget exhausted" });
    }
    await this.store.patchTask(taskId, { repairCycles: task.repairCycles + 1 });
    await this.store.appendEvent(taskId, "repair.requested", { instructions });
    if (task.state !== "repairing") await this.store.transition(taskId, "repairing");
    return this.enqueue(taskId);
  }

  private push(taskId: string): void {
    if (this.queued.has(taskId) || this.active.has(taskId)) return;
    this.queued.add(taskId);
    this.queue.push(taskId);
  }

  private pump(): void {
    if (this.paused) return;
    while (this.active.size < this.effectiveConcurrency && this.queue.length > 0) {
      const taskId = this.queue.shift()!;
      this.queued.delete(taskId);
      const controller = new AbortController();
      this.active.set(taskId, controller);
      void this.run(taskId, controller).finally(() => {
        this.active.delete(taskId);
        this.pump();
      });
    }
  }

  private async run(taskId: string, controller: AbortController): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      const task = await this.store.getTask(taskId);
      const plan = await this.store.getPlan(taskId);
      const phase = task.repairCycles > 0 ? "repair" : "initial";
      const events = await this.store.readEvents(taskId);
      const lastStarted = events.filter((event) => event.type === "execution.started").at(-1)?.sequence ?? 0;
      const lastCompleted = events.filter((event) => event.type === "execution.completed").at(-1)?.sequence ?? 0;
      const resumingInterruptedExecution = lastStarted > lastCompleted;
      const repairInstructions = events
        .filter((event) => event.type === "repair.requested")
        .flatMap((event) => ((event.data as { instructions?: string[] }).instructions ?? []));
      if (phase === "initial" && !resumingInterruptedExecution) {
        const currentFingerprint = await computeWorkspaceFingerprint(plan.workspace);
        if (currentFingerprint !== plan.baseFingerprint) throw new Error("stale plan: workspace changed while task was queued");
      }
      await this.store.transition(taskId, "executing");
      if (phase === "repair") await this.store.transition(taskId, "repairing");
      const previousEvidence = await this.store.getEvidence(taskId);
      const evidence: ExecutionEvidence = {
        taskId,
        state: phase === "repair" ? "repairing" : "executing",
        startedAt: new Date().toISOString(),
        validation: [],
        validationPolicy: evaluatePlanValidation(plan),
        reviews: previousEvidence.reviews,
        unresolvedRisks: [],
        artifacts: previousEvidence.artifacts,
      };
      const executorSessionId = previousEvidence.executor?.sessionId ?? previousEvidence.executorSessionId ?? randomUUID();
      evidence.executorSessionId = executorSessionId;
      await this.store.setEvidence(taskId, evidence);
      await this.store.appendEvent(taskId, "execution.started", { phase, sessionId: executorSessionId, resumed: resumingInterruptedExecution });
      timeout = setTimeout(() => controller.abort(), plan.execution.budgets.timeoutMinutes * 60_000);
      timeout.unref();
      const result = await this.executor.execute({
        plan,
        phase,
        repairInstructions,
        signal: controller.signal,
        maxTurns: phase === "repair" ? plan.execution.budgets.repairTurns : plan.execution.budgets.initialTurns,
        maxMessages: plan.execution.budgets.messages,
        sessionId: executorSessionId,
        runDirectory: this.store.taskDirectory(taskId),
        resumeSession: resumingInterruptedExecution,
      });
      for (const signal of result.upstreamSignals) this.reportUpstreamSignal(signal);
      if (controller.signal.aborted) {
        const current = await this.store.getTask(taskId);
        if (current.state !== "cancelled") await this.finish(taskId, "partial", { ...evidence, executor: result, unresolvedRisks: ["task timeout exceeded"] }, "task timeout exceeded");
        return;
      }
      if (result.exitCode !== 0) {
        await this.finish(taskId, "partial", { ...evidence, executor: result, unresolvedRisks: ["executor exited unsuccessfully"] }, result.stderr);
        return;
      }
      const turnBudget = phase === "repair" ? plan.execution.budgets.repairTurns : plan.execution.budgets.initialTurns;
      if (result.turns > turnBudget || result.messages > plan.execution.budgets.messages) {
        await this.finish(taskId, "partial", { ...evidence, executor: result, unresolvedRisks: ["execution budget exceeded"] }, "execution budget exceeded");
        return;
      }
      await this.store.transition(taskId, "validating");
      const validation = await this.validator.validate(plan, controller.signal);
      await this.store.writeVerification(taskId, validation);
      const updatedEvidence: ExecutionEvidence = { ...evidence, state: "validating", executor: result, validation, validationPolicy: evaluatePlanValidation(plan) };
      await this.store.setEvidence(taskId, updatedEvidence);
      const validationFailed = validation.some((check) => check.exitCode !== 0);
      const expectedFiles = plan.steps.flatMap((step) => step.expectedFiles);
      const planDeviation = expectedFiles.length > 0 && result.changedFiles.some((file) => !isExpectedFile(file, expectedFiles));
      const needsReview = plan.review.policy === "always"
        || (plan.review.policy === "adaptive" && (validationFailed || planDeviation || plan.risk !== "low" || result.changedFiles.length > 5 || result.diffLines > 500));
      if (validationFailed && !needsReview) {
        await this.finish(taskId, "partial", { ...updatedEvidence, unresolvedRisks: ["one or more deterministic checks failed"] }, "deterministic validation failed");
        return;
      }
      if (needsReview) {
        const reviewing = { ...updatedEvidence, state: "reviewing" as const, unresolvedRisks: [
          ...(validationFailed ? ["one or more deterministic checks failed"] : []),
          ...(planDeviation ? ["changed files outside plan expectedFiles"] : []),
          "external review required",
        ] };
        await this.store.setEvidence(taskId, reviewing);
        await this.store.transition(taskId, "reviewing", { lastError: "external review required" });
        await this.store.appendEvent(taskId, "execution.completed", { state: "reviewing" });
        return;
      }
      await this.finish(taskId, "passed", updatedEvidence);
    } catch (error) {
      try {
        const current = await this.store.getTask(taskId);
        if (current.state !== "cancelled") await this.finish(taskId, controller.signal.aborted ? "partial" : "failed", await this.store.getEvidence(taskId), errorMessage(error));
      } catch {
        // Preserve the original failure; corrupt-store failures are visible in daemon logs/RPC.
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      this.emit("settled", taskId);
    }
  }

  private async finish(taskId: string, state: "passed" | "partial" | "failed", evidence: ExecutionEvidence, lastError?: string): Promise<void> {
    const complete = { ...evidence, state, completedAt: new Date().toISOString() };
    await this.store.setEvidence(taskId, complete);
    await this.store.transition(taskId, state, { lastError });
    await this.store.appendEvent(taskId, "execution.completed", { state });
  }

  private async setEvidenceState(taskId: string, state: "passed" | "blocked", risk?: string): Promise<void> {
    const evidence = await this.store.getEvidence(taskId);
    await this.store.setEvidence(taskId, {
      ...evidence,
      state,
      completedAt: new Date().toISOString(),
      unresolvedRisks: risk ? [...evidence.unresolvedRisks, risk] : evidence.unresolvedRisks.filter((item) => item !== "external review required"),
    });
  }
}

function clampConcurrency(value: number): number {
  if (!Number.isInteger(value)) throw new Error("concurrency must be an integer");
  return Math.max(1, Math.min(4, value));
}

function isExpectedFile(changedFile: string, expectedFiles: string[]): boolean {
  const normalized = changedFile.replaceAll("\\", "/").replace(/^\.\//, "");
  return expectedFiles.some((expected) => {
    const candidate = expected.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    return normalized === candidate || normalized.startsWith(`${candidate}/`);
  });
}

function hasCompleteSuccessfulEvidence(plan: MyClaudePlan, evidence: ExecutionEvidence): boolean {
  if (evidence.executor?.exitCode !== 0) return false;
  if (evidence.validation.length !== plan.validation.commands.length) return false;
  return plan.validation.commands.every((declared, index) => {
    const actual = evidence.validation[index];
    return actual?.command === declared.command && actual.exitCode === 0;
  });
}
