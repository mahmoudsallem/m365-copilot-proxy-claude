import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { ExecutionBudgetUsage, ExecutionEvidence, MyClaudePlan, MyClaudeReview, TaskRecord } from "./schemas.js";
import { reviewEvidenceSha256, TERMINAL_TASK_STATES } from "./schemas.js";
import type { ExecutionResult, ExecutorAdapter, ValidatorAdapter } from "./runner.js";
import { errorMessage } from "./util.js";
import { assessValidationEvidence, TaskStore } from "./store.js";
import { computeWorkspaceFingerprint } from "./fingerprint.js";
import { assertSafeValidationPlan, evaluatePlanValidation } from "./validation-policy.js";
import { assertWorkspaceAllowed, workspacesOverlap } from "./workspace-policy.js";

export interface SchedulerOptions {
  concurrency?: number;
  executionProfile?: "guarded" | "host-unrestricted";
  allowedWorkspaceRoots?: string[];
}

export class TaskScheduler extends EventEmitter {
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private readonly active = new Map<string, AbortController>();
  private readonly admittedWorkspaces = new Map<string, string>();
  private readonly activeWorkspaces = new Map<string, string>();
  private readonly approvalWorkspaceReservations = new Map<string, string>();
  private readonly workspaceLeaseWaiters = new Set<() => void>();
  private readonly admissionLocks = new Map<string, Promise<void>>();
  private configuredConcurrency: number;
  private effectiveConcurrency: number;
  private paused = false;
  private degraded = false;
  private shuttingDown = false;
  private readonly executionProfile: "guarded" | "host-unrestricted";
  private readonly allowedWorkspaceRoots: string[];

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
    this.allowedWorkspaceRoots = options.allowedWorkspaceRoots ?? [];
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
      allowedWorkspaceRoots: this.allowedWorkspaceRoots,
    };
  }

  async recover(): Promise<void> {
    for (const task of await this.store.listTasks()) {
      if (["queued", "executing", "validating", "repairing"].includes(task.state)) {
        await this.withAdmissionLock(task.id, async () => {
          try {
            if (!task.planSha256) throw new Error("task has no immutable plan");
            const plan = await this.store.getPlan(task.id);
            await this.admitPlan(task.id, plan, true);
            if (task.state !== "queued") {
              await this.store.transition(task.id, "queued", { lastError: "recovered after orchestrator restart" });
            }
            await this.store.appendEvent(task.id, "task.recovered", { previousState: task.state });
            this.push(task.id);
          } catch (error) {
            await this.quarantineRecovery(task.id, task.state, errorMessage(error));
          }
        });
      }
    }
    this.pump();
  }

  async enqueue(taskId: string): Promise<TaskRecord> {
    return this.withAdmissionLock(taskId, async () => {
      const current = await this.store.getTask(taskId);
      if (this.active.has(taskId)) throw new Error(`task_start rejected: task ${taskId} is actively executing`);
      if (!current.planSha256) throw new Error("task has no immutable plan");
      if (!new Set(["planned", "queued"]).has(current.state)) {
        throw new Error(`task_start rejected while task is ${current.state}`);
      }
      if (current.state === "queued" && this.queued.has(taskId)) return current;
      const plan = await this.store.getPlan(taskId);
      await this.admitPlan(taskId, plan, true);
      return this.queuePrepared(taskId, current);
    });
  }

  async cancel(taskId: string): Promise<TaskRecord> {
    this.queued.delete(taskId);
    const index = this.queue.indexOf(taskId);
    if (index >= 0) this.queue.splice(index, 1);
    if (!this.active.has(taskId)) this.admittedWorkspaces.delete(taskId);
    this.active.get(taskId)?.abort();
    const current = await this.store.getTask(taskId);
    if (TERMINAL_TASK_STATES.has(current.state)) return current;
    const evidence = await this.store.getEvidence(taskId);
    const cancelled = await this.store.finalizeExecution(taskId, "cancelled", {
      ...evidence,
      state: "cancelled",
      unresolvedRisks: [...evidence.unresolvedRisks, "execution cancelled"],
    }, "execution cancelled");
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
    this.shuttingDown = true;
    this.pause();
    // A daemon/service stop is an interruption, not a user cancellation. Keep
    // queued work queued and abort only active workers so a new daemon can
    // recover them with the same executor session.
    for (const controller of this.active.values()) controller.abort();
    const deadline = Date.now() + timeoutMs;
    while (this.active.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (this.active.size > 0) {
      throw new Error(`scheduler shutdown timed out with active tasks: ${[...this.active.keys()].join(", ")}`);
    }
  }

  async applyReview(taskId: string, review: MyClaudeReview): Promise<TaskRecord> {
    return this.withAdmissionLock(taskId, async () => {
      const current = await this.store.getTask(taskId);
      if (this.active.has(taskId)) throw new Error(`review rejected: task ${taskId} is actively executing`);
      const plan = await this.store.getPlan(taskId);
      if (!["reviewing", "partial", "failed"].includes(current.state)) {
        throw new Error(`reviews are not accepted while task is ${current.state}`);
      }
      const evidence = await this.store.getEvidence(taskId);
      if (!evidence.attemptId || !current.planSha256
        || review.binding.attemptId !== evidence.attemptId
        || review.binding.planSha256 !== current.planSha256
        || review.binding.evidenceSha256 !== reviewEvidenceSha256(evidence)) {
        throw new Error("review rejected: binding does not match the current execution attempt, plan, and evidence");
      }
      if (review.verdict === "approve") {
        if (review.reviewer.provider === "human") {
          throw new Error("approval rejected: human/self-declared approvals are not accepted by the verified executor");
        }
        if (current.state !== "reviewing") {
          throw new Error(`approval rejected: task is ${current.state}, not reviewing`);
        }
        if (evidence.state !== "reviewing" || !hasCompleteSuccessfulEvidence(plan, evidence)) {
          throw new Error("approval rejected: current execution and every declared validation command must have fresh successful evidence");
        }
        let canonicalWorkspace: string;
        try {
          canonicalWorkspace = await assertWorkspaceAllowed(plan.workspace, {
            allowedRoots: this.allowedWorkspaceRoots,
            stateRoot: this.store.stateRoot,
          });
        } catch {
          return this.rejectStaleApproval(taskId, evidence, "approval rejected: workspace canonical path could not be resolved; fresh execution and validation are required");
        }
        return this.withApprovalWorkspaceLease(taskId, canonicalWorkspace, async () => {
          const [approvalTask, approvalEvidence] = await Promise.all([
            this.store.getTask(taskId),
            this.store.getEvidence(taskId),
          ]);
          if (approvalTask.state !== "reviewing"
            || approvalEvidence.state !== "reviewing"
            || !approvalEvidence.attemptId
            || !approvalTask.planSha256
            || review.binding.attemptId !== approvalEvidence.attemptId
            || review.binding.planSha256 !== approvalTask.planSha256
            || review.binding.evidenceSha256 !== reviewEvidenceSha256(approvalEvidence)
            || !hasCompleteSuccessfulEvidence(plan, approvalEvidence)) {
            throw new Error("approval rejected: task state or bound execution evidence changed while waiting for the workspace lease");
          }
          let currentCanonicalWorkspace: string;
          try {
            currentCanonicalWorkspace = await assertWorkspaceAllowed(plan.workspace, {
              allowedRoots: this.allowedWorkspaceRoots,
              stateRoot: this.store.stateRoot,
            });
          } catch {
            return this.rejectStaleApproval(taskId, approvalEvidence, "approval rejected: workspace canonical path could not be resolved while waiting for the approval lease; fresh execution and validation are required");
          }
          if (currentCanonicalWorkspace !== canonicalWorkspace
            || approvalEvidence.workspaceCanonicalPath !== canonicalWorkspace) {
            return this.rejectStaleApproval(taskId, approvalEvidence, "approval rejected: workspace canonical path changed while waiting for the approval lease; fresh execution and validation are required");
          }
          const verifiedFingerprint = approvalEvidence.workspaceFingerprintAfterValidation;
          if (!verifiedFingerprint) {
            return this.rejectStaleApproval(taskId, approvalEvidence, "approval rejected: verified workspace fingerprint is missing; fresh execution and validation are required");
          }
          let currentFingerprint: string;
          try {
            currentFingerprint = await computeWorkspaceFingerprint(canonicalWorkspace);
          } catch {
            return this.rejectStaleApproval(taskId, approvalEvidence, "approval rejected: workspace fingerprint could not be recomputed; fresh execution and validation are required");
          }
          if (currentFingerprint !== verifiedFingerprint) {
            return this.rejectStaleApproval(taskId, approvalEvidence, "approval rejected: workspace changed after deterministic validation; fresh execution and validation are required");
          }
          await this.store.addReview(taskId, review);
          const approvedEvidence = await this.store.getEvidence(taskId);
          return this.store.finalizeExecution(taskId, "passed", {
            ...approvedEvidence,
            state: "passed",
            unresolvedRisks: approvedEvidence.unresolvedRisks.filter((item) => item !== "external review required"),
          });
        });
      }
      await this.store.addReview(taskId, review);
      const reviewed = await this.store.getTask(taskId);
      if (review.verdict === "blocked") {
        const blockedEvidence = await this.store.getEvidence(taskId);
        return this.store.finalizeExecution(taskId, "blocked", {
          ...blockedEvidence,
          state: "blocked",
          unresolvedRisks: [...blockedEvidence.unresolvedRisks, review.summary],
        }, review.summary);
      }
      if (reviewed.repairCycles >= plan.execution.budgets.reviewCycles) {
        const blockedEvidence = await this.store.getEvidence(taskId);
        return this.store.finalizeExecution(taskId, "blocked", {
          ...blockedEvidence,
          state: "blocked",
          unresolvedRisks: [...blockedEvidence.unresolvedRisks, "review repair-cycle budget exhausted"],
        }, "review repair-cycle budget exhausted");
      }
      await this.admitPlan(taskId, plan, false);
      await this.store.appendEvent(taskId, "repair.requested", { instructions: review.repairInstructions, source: "review" });
      await this.store.patchTask(taskId, { repairCycles: reviewed.repairCycles + 1 });
      await this.store.transition(taskId, "repairing");
      return this.queuePrepared(taskId);
    });
  }

  async requestRepair(taskId: string, instructions: string[] = []): Promise<TaskRecord> {
    return this.withAdmissionLock(taskId, async () => {
      const task = await this.store.getTask(taskId);
      if (this.active.has(taskId) || this.queued.has(taskId)) {
        throw new Error(`repair rejected: task ${taskId} is active or queued`);
      }
      if (!new Set(["reviewing", "partial", "failed", "blocked"]).has(task.state)) {
        throw new Error(`repair rejected while task is ${task.state}`);
      }
      const plan = await this.store.getPlan(taskId);
      await this.admitPlan(taskId, plan, false);
      if (task.repairCycles >= plan.execution.budgets.reviewCycles) {
        const blockedEvidence = await this.store.getEvidence(taskId);
        return this.store.finalizeExecution(taskId, "blocked", {
          ...blockedEvidence,
          state: "blocked",
          unresolvedRisks: [...blockedEvidence.unresolvedRisks, "repair-cycle budget exhausted"],
        }, "repair-cycle budget exhausted");
      }
      await this.store.patchTask(taskId, { repairCycles: task.repairCycles + 1 });
      await this.store.appendEvent(taskId, "repair.requested", { instructions });
      await this.store.transition(taskId, "repairing");
      return this.queuePrepared(taskId);
    });
  }

  private async withAdmissionLock<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    const prior = this.admissionLocks.get(taskId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const chained = prior.then(() => current);
    this.admissionLocks.set(taskId, chained);
    await prior;
    try {
      return await action();
    } finally {
      release();
      if (this.admissionLocks.get(taskId) === chained) this.admissionLocks.delete(taskId);
    }
  }

  private async withApprovalWorkspaceLease<T>(taskId: string, workspace: string, action: () => Promise<T>): Promise<T> {
    const token = `approval:${taskId}:${randomUUID()}`;
    this.approvalWorkspaceReservations.set(token, workspace);
    try {
      while (!this.canAcquireApprovalWorkspaceLease(token, workspace)) {
        await new Promise<void>((resolve) => this.workspaceLeaseWaiters.add(resolve));
      }
      return await action();
    } finally {
      this.approvalWorkspaceReservations.delete(token);
      this.notifyWorkspaceLeaseWaiters();
      this.pump();
    }
  }

  private canAcquireApprovalWorkspaceLease(token: string, workspace: string): boolean {
    if ([...this.activeWorkspaces.values()].some((active) => workspacesOverlap(workspace, active))) return false;
    for (const [reservation, reservedWorkspace] of this.approvalWorkspaceReservations) {
      if (reservation === token) break;
      if (workspacesOverlap(workspace, reservedWorkspace)) return false;
    }
    return true;
  }

  private notifyWorkspaceLeaseWaiters(): void {
    const waiters = [...this.workspaceLeaseWaiters];
    this.workspaceLeaseWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  private async rejectStaleApproval(taskId: string, evidence: ExecutionEvidence, reason: string): Promise<never> {
    const unresolvedRisks = [...new Set([...evidence.unresolvedRisks, reason])];
    await this.store.invalidateVerification(taskId, [reason]);
    await this.store.finalizeExecution(taskId, "partial", {
      ...evidence,
      state: "partial",
      unresolvedRisks,
    }, reason);
    await this.store.appendEvent(taskId, "review.approval_rejected", { reason, staleWorkspace: true });
    throw new Error(reason);
  }

  private async admitPlan(taskId: string, plan: MyClaudePlan, checkStaleBase: boolean): Promise<void> {
    const canonicalWorkspace = await assertWorkspaceAllowed(plan.workspace, {
      allowedRoots: this.allowedWorkspaceRoots,
      stateRoot: this.store.stateRoot,
    });
    const validationPolicy = evaluatePlanValidation(plan);
    await this.store.appendEvent(taskId, "validation.policy", {
      profile: this.executionProfile,
      profileAllowed: plan.execution.profile === this.executionProfile,
      decisions: validationPolicy,
    });
    if (plan.execution.profile !== this.executionProfile) {
      throw new Error(`plan execution profile ${plan.execution.profile} is not allowed by daemon policy ${this.executionProfile}`);
    }
    assertSafeValidationPlan(plan);
    if (checkStaleBase) {
      const priorEvents = await this.store.readEvents(taskId);
      if (!priorEvents.some((event) => event.type === "execution.started")) {
        const currentFingerprint = await computeWorkspaceFingerprint(canonicalWorkspace);
        if (currentFingerprint !== plan.baseFingerprint) {
          throw new Error(`stale plan: workspace fingerprint changed (planned ${plan.baseFingerprint}, current ${currentFingerprint})`);
        }
      }
    }
    this.admittedWorkspaces.set(taskId, canonicalWorkspace);
  }

  private async queuePrepared(taskId: string, record?: TaskRecord): Promise<TaskRecord> {
    if (this.active.has(taskId)) throw new Error(`cannot queue task ${taskId} while it is actively executing`);
    const current = record ?? await this.store.getTask(taskId);
    const queued = current.state === "queued"
      ? current
      : await this.store.transition(taskId, "queued", { cancellationRequested: false, lastError: undefined });
    this.push(taskId);
    this.pump();
    return queued;
  }

  private async quarantineRecovery(taskId: string, previousState: TaskRecord["state"], reason: string): Promise<void> {
    const evidence = await this.store.getEvidence(taskId);
    const risk = `recovery admission rejected: ${reason}`;
    await this.store.invalidateVerification(taskId, [risk]);
    await this.store.finalizeExecution(taskId, "failed", {
      ...evidence,
      state: "failed",
      unresolvedRisks: [...new Set([...evidence.unresolvedRisks, risk])],
    }, risk);
    await this.store.appendEvent(taskId, "task.recovery_quarantined", { previousState, reason });
  }

  private push(taskId: string): void {
    if (this.queued.has(taskId) || this.active.has(taskId)) return;
    this.queued.add(taskId);
    this.queue.push(taskId);
  }

  private pump(): void {
    if (this.paused) return;
    while (this.active.size < this.effectiveConcurrency && this.queue.length > 0) {
      const eligibleIndex = this.queue.findIndex((candidate) => {
        const workspace = this.admittedWorkspaces.get(candidate);
        return workspace !== undefined
          && [...this.activeWorkspaces.values()].every((active) => !workspacesOverlap(workspace, active))
          && [...this.approvalWorkspaceReservations.values()].every((reserved) => !workspacesOverlap(workspace, reserved));
      });
      if (eligibleIndex < 0) return;
      const [taskId] = this.queue.splice(eligibleIndex, 1);
      this.queued.delete(taskId);
      const controller = new AbortController();
      this.active.set(taskId, controller);
      this.activeWorkspaces.set(taskId, this.admittedWorkspaces.get(taskId)!);
      void this.run(taskId, controller).finally(() => {
        this.active.delete(taskId);
        this.activeWorkspaces.delete(taskId);
        this.admittedWorkspaces.delete(taskId);
        this.notifyWorkspaceLeaseWaiters();
        this.pump();
      });
    }
  }

  private async run(taskId: string, controller: AbortController): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      const task = await this.store.getTask(taskId);
      const storedPlan = await this.store.getPlan(taskId);
      const admittedWorkspace = this.admittedWorkspaces.get(taskId);
      if (!admittedWorkspace) throw new Error("workspace lease admission is missing");
      const canonicalWorkspace = await assertWorkspaceAllowed(storedPlan.workspace, {
        allowedRoots: this.allowedWorkspaceRoots,
        stateRoot: this.store.stateRoot,
      });
      if (canonicalWorkspace !== admittedWorkspace) {
        throw new Error(`workspace canonical path changed while task was queued (admitted ${admittedWorkspace}, current ${canonicalWorkspace})`);
      }
      // Never hand a mutable symlink spelling to an executor or validator. The
      // immutable stored plan remains unchanged; only this runtime view uses the
      // canonical path protected by the scheduler lease.
      const plan: MyClaudePlan = storedPlan.workspace === canonicalWorkspace
        ? storedPlan
        : { ...storedPlan, workspace: canonicalWorkspace };
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
      const budgetUsage = taskBudgetUsage(previousEvidence, plan, events, task.repairCycles, Date.now());
      const budgetCycle = phase === "repair" ? `repair:${task.repairCycles}` : "initial";
      const allowance = remainingExecutionBudget(plan, budgetUsage, budgetCycle, phase);
      const attemptId = resumingInterruptedExecution && previousEvidence.attemptId
        ? previousEvidence.attemptId
        : randomUUID();
      const evidence: ExecutionEvidence = {
        taskId,
        state: phase === "repair" ? "repairing" : "executing",
        attemptId,
        planSha256: task.planSha256,
        startedAt: budgetUsage.startedAt,
        budgetUsage,
        workspaceCanonicalPath: canonicalWorkspace,
        validation: [],
        validationPolicy: evaluatePlanValidation(plan),
        reviews: previousEvidence.reviews,
        unresolvedRisks: [],
        artifacts: previousEvidence.artifacts,
      };
      const executorSessionId = previousEvidence.executor?.sessionId ?? previousEvidence.executorSessionId ?? randomUUID();
      evidence.executorSessionId = executorSessionId;
      await this.store.setEvidence(taskId, evidence);
      await this.store.appendEvent(taskId, "execution.started", {
        phase,
        repairCycle: phase === "repair" ? task.repairCycles : 0,
        sessionId: executorSessionId,
        attemptId,
        resumed: resumingInterruptedExecution,
        remainingTurns: allowance.turns,
        remainingMessages: allowance.messages,
        deadlineAt: budgetUsage.deadlineAt,
      });
      const exhaustedReason = exhaustedBudgetReason(allowance);
      if (exhaustedReason) {
        await this.finish(taskId, "partial", {
          ...evidence,
          unresolvedRisks: [exhaustedReason],
        }, exhaustedReason);
        return;
      }
      timeout = setTimeout(() => controller.abort(), allowance.timeoutMs);
      timeout.unref();
      const result = await this.executor.execute({
        plan,
        phase,
        repairInstructions,
        signal: controller.signal,
        maxTurns: allowance.turns,
        maxMessages: allowance.messages,
        deadlineAt: budgetUsage.deadlineAt,
        sessionId: executorSessionId,
        runDirectory: this.store.taskDirectory(taskId),
        resumeSession: resumingInterruptedExecution,
      });
      const chargedUsage = chargeExecutionUsage(budgetUsage, budgetCycle, result);
      const executedEvidence: ExecutionEvidence = { ...evidence, executor: result, budgetUsage: chargedUsage };
      for (const signal of result.upstreamSignals) this.reportUpstreamSignal(signal);
      if ((result.continuations ?? 0) > 0) {
        await this.store.appendEvent(taskId, "execution.continued", {
          continuations: result.continuations,
          checkpoints: result.checkpointFiles ?? [],
          recovered: !result.truncated,
        });
      }
      if (controller.signal.aborted) {
        const current = await this.store.getTask(taskId);
        if (current.state === "cancelled") return;
        if (this.shuttingDown) {
          await this.interruptForShutdown(taskId, executedEvidence);
          return;
        }
        await this.finish(taskId, "partial", { ...executedEvidence, unresolvedRisks: ["task deadline exceeded"] }, "task deadline exceeded");
        return;
      }
      await this.store.setEvidence(taskId, executedEvidence);
      await this.store.appendEvent(taskId, "execution.usage", {
        phase,
        repairCycle: phase === "repair" ? task.repairCycles : 0,
        turns: result.turns,
        messages: Math.max(1, result.messages),
        cumulativeTurns: chargedUsage.turnsUsed,
        cumulativeMessages: chargedUsage.messagesUsed,
      });
      if (result.exitCode !== 0) {
        await this.finish(taskId, "partial", { ...executedEvidence, unresolvedRisks: ["executor exited unsuccessfully"] }, result.stderr);
        return;
      }
      if (result.truncated) {
        await this.finish(taskId, "partial", {
          ...executedEvidence,
          unresolvedRisks: ["executor output remained truncated after bounded continuation attempts"],
        }, "executor output remained truncated after bounded continuation attempts");
        return;
      }
      if (result.turns > allowance.turns || Math.max(1, result.messages) > allowance.messages) {
        await this.finish(taskId, "partial", { ...executedEvidence, unresolvedRisks: ["cumulative execution budget exceeded"] }, "cumulative execution budget exceeded");
        return;
      }
      await this.store.transition(taskId, "validating");
      const workspaceFingerprintBeforeValidation = await computeWorkspaceFingerprint(plan.workspace);
      const validation = await this.validator.validate(plan, controller.signal);
      const workspaceFingerprintAfterValidation = await computeWorkspaceFingerprint(plan.workspace);
      const baseValidationAssessment = assessValidationEvidence(plan.validation.commands, validation);
      const validationAssessment = workspaceFingerprintBeforeValidation === workspaceFingerprintAfterValidation
        ? baseValidationAssessment
        : {
            passed: false,
            issues: [
              ...baseValidationAssessment.issues,
              "workspace changed while deterministic validation was running",
            ],
          };
      if (validationAssessment.passed) {
        await this.store.writeVerification(taskId, plan.validation.commands, validation);
      } else {
        await this.store.invalidateVerification(taskId, validationAssessment.issues);
      }
      const updatedEvidence: ExecutionEvidence = {
        ...executedEvidence,
        state: "validating",
        validation,
        validationPolicy: evaluatePlanValidation(plan),
        workspaceFingerprintBeforeValidation,
        workspaceFingerprintAfterValidation,
      };
      await this.store.setEvidence(taskId, updatedEvidence);
      const validationFailed = !validationAssessment.passed;
      const expectedFiles = plan.steps.flatMap((step) => step.expectedFiles);
      const planDeviation = expectedFiles.length > 0 && result.changedFiles.some((file) => !isExpectedFile(file, expectedFiles));
      const needsReview = plan.review.policy === "always"
        || (plan.review.policy === "adaptive" && (validationFailed || planDeviation || plan.risk !== "low" || result.changedFiles.length > 5 || result.diffLines > 500));
      if (validationFailed && !needsReview) {
        await this.finish(taskId, "partial", { ...updatedEvidence, unresolvedRisks: validationAssessment.issues }, "deterministic validation failed");
        return;
      }
      if (needsReview) {
        const reviewing = { ...updatedEvidence, state: "reviewing" as const, unresolvedRisks: [
          ...(validationFailed ? validationAssessment.issues : []),
          ...(planDeviation ? ["changed files outside plan expectedFiles"] : []),
          "external review required",
        ] };
        await this.store.finalizeExecution(taskId, "reviewing", reviewing, "external review required");
        return;
      }
      await this.finish(taskId, "passed", updatedEvidence);
    } catch (error) {
      try {
        const current = await this.store.getTask(taskId);
        if (current.state === "cancelled") return;
        if (controller.signal.aborted && this.shuttingDown) {
          await this.interruptForShutdown(taskId, await this.store.getEvidence(taskId));
          return;
        }
        await this.finish(taskId, controller.signal.aborted ? "partial" : "failed", await this.store.getEvidence(taskId), errorMessage(error));
      } catch {
        // Preserve the original failure; corrupt-store failures are visible in daemon logs/RPC.
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      this.emit("settled", taskId);
    }
  }

  private async finish(taskId: string, state: "passed" | "partial" | "failed", evidence: ExecutionEvidence, lastError?: string): Promise<void> {
    await this.store.finalizeExecution(taskId, state, { ...evidence, state }, lastError);
  }

  private async interruptForShutdown(taskId: string, evidence: ExecutionEvidence): Promise<void> {
    const current = await this.store.getTask(taskId);
    if (TERMINAL_TASK_STATES.has(current.state) || current.state === "queued") return;
    const reason = "execution interrupted by daemon shutdown; queued for recovery";
    await this.store.setEvidence(taskId, {
      ...evidence,
      state: "queued",
      completedAt: undefined,
      unresolvedRisks: [...new Set([...evidence.unresolvedRisks, reason])],
    });
    await this.store.transition(taskId, "queued", { lastError: reason });
    await this.store.appendEvent(taskId, "task.interrupted", { reason: "daemon shutdown", resumable: true });
  }

}

interface RemainingExecutionBudget {
  turns: number;
  messages: number;
  timeoutMs: number;
}

function taskBudgetUsage(
  evidence: ExecutionEvidence,
  plan: MyClaudePlan,
  events: Awaited<ReturnType<TaskStore["readEvents"]>>,
  repairCycles: number,
  now: number,
): ExecutionBudgetUsage {
  const timeoutMs = plan.execution.budgets.timeoutMinutes * 60_000;
  if (evidence.budgetUsage) {
    const usage = evidence.budgetUsage;
    const startedMs = Date.parse(usage.startedAt);
    const deadlineMs = Date.parse(usage.deadlineAt);
    if (!Number.isFinite(startedMs) || !Number.isFinite(deadlineMs) || deadlineMs !== startedMs + timeoutMs) {
      throw new Error("stored cumulative execution deadline is invalid");
    }
    if (!isUsageCount(usage.turnsUsed) || !isUsageCount(usage.messagesUsed)) {
      throw new Error("stored cumulative execution usage is invalid");
    }
    const cycleEntries = Object.entries(usage.cycleTurns);
    if (cycleEntries.some(([key, value]) => !/^(?:initial|repair:[1-9]\d*)$/.test(key) || !isUsageCount(value))) {
      throw new Error("stored cumulative turn-cycle usage is invalid");
    }
    if (cycleEntries.reduce((total, [, value]) => total + value, 0) !== usage.turnsUsed) {
      throw new Error("stored cumulative turn usage does not match its cycle ledger");
    }
    return {
      startedAt: new Date(startedMs).toISOString(),
      deadlineAt: new Date(deadlineMs).toISOString(),
      turnsUsed: usage.turnsUsed,
      messagesUsed: usage.messagesUsed,
      cycleTurns: { ...usage.cycleTurns },
    };
  }

  // Upgrade unfinished tasks created before the durable ledger existed. Charge
  // the last recorded executor result instead of silently resetting it.
  const priorStartedMs = evidence.startedAt ? Date.parse(evidence.startedAt) : Number.NaN;
  const startedMs = Number.isFinite(priorStartedMs) && priorStartedMs <= now ? priorStartedMs : now;
  const priorTurns = isUsageCount(evidence.executor?.turns) ? evidence.executor.turns : 0;
  const priorMessages = isUsageCount(evidence.executor?.messages) ? Math.max(1, evidence.executor.messages) : 0;
  const lastStart = events.filter((event) => event.type === "execution.started").at(-1);
  const data = (lastStart?.data ?? {}) as { phase?: string; repairCycle?: number };
  const priorCycle = data.phase === "repair"
    ? `repair:${isUsageCount(data.repairCycle) && data.repairCycle > 0 ? data.repairCycle : Math.max(1, repairCycles)}`
    : "initial";
  return {
    startedAt: new Date(startedMs).toISOString(),
    deadlineAt: new Date(startedMs + timeoutMs).toISOString(),
    turnsUsed: priorTurns,
    messagesUsed: priorMessages,
    cycleTurns: priorTurns > 0 ? { [priorCycle]: priorTurns } : {},
  };
}

function remainingExecutionBudget(
  plan: MyClaudePlan,
  usage: ExecutionBudgetUsage,
  cycle: string,
  phase: "initial" | "repair",
): RemainingExecutionBudget {
  const perCycleLimit = phase === "repair"
    ? plan.execution.budgets.repairTurns
    : plan.execution.budgets.initialTurns;
  const totalTurnLimit = plan.execution.budgets.initialTurns
    + plan.execution.budgets.repairTurns * plan.execution.budgets.reviewCycles;
  return {
    turns: Math.max(0, Math.min(
      perCycleLimit - (usage.cycleTurns[cycle] ?? 0),
      totalTurnLimit - usage.turnsUsed,
    )),
    messages: Math.max(0, plan.execution.budgets.messages - usage.messagesUsed),
    timeoutMs: Math.max(0, Date.parse(usage.deadlineAt) - Date.now()),
  };
}

function exhaustedBudgetReason(remaining: RemainingExecutionBudget): string | undefined {
  if (remaining.timeoutMs <= 0) return "task deadline exhausted before execution";
  if (remaining.messages <= 0) return "cumulative message budget exhausted before execution";
  if (remaining.turns <= 0) return "cumulative turn budget exhausted before execution";
  return undefined;
}

function chargeExecutionUsage(
  usage: ExecutionBudgetUsage,
  cycle: string,
  result: Pick<ExecutionResult, "turns" | "messages">,
): ExecutionBudgetUsage {
  if (!isUsageCount(result.turns) || !isUsageCount(result.messages)) {
    throw new Error("executor returned invalid turn or message usage");
  }
  const messages = Math.max(1, result.messages);
  return {
    ...usage,
    turnsUsed: usage.turnsUsed + result.turns,
    messagesUsed: usage.messagesUsed + messages,
    cycleTurns: {
      ...usage.cycleTurns,
      [cycle]: (usage.cycleTurns[cycle] ?? 0) + result.turns,
    },
  };
}

function isUsageCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
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
  return assessValidationEvidence(plan.validation.commands, evidence.validation).passed;
}
