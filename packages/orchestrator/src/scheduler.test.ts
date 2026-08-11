import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { computeWorkspaceFingerprint } from "./fingerprint.js";
import type { ExecutionContext, ExecutionResult, ExecutorAdapter, ValidatorAdapter } from "./runner.js";
import { TaskScheduler } from "./scheduler.js";
import { TaskStore } from "./store.js";
import { makePlan } from "./test-helpers.js";

const exec = promisify(execFile);
const roots: string[] = [];

class FakeExecutor implements ExecutorAdapter {
  active = 0;
  maximum = 0;
  sessions: Array<string | undefined> = [];
  constructor(private readonly delay = 0, private readonly signals: ExecutionResult["upstreamSignals"] = []) {}
  async execute(context: ExecutionContext): Promise<ExecutionResult> {
    this.active += 1;
    this.maximum = Math.max(this.maximum, this.active);
    this.sessions.push(context.sessionId);
    if (this.delay) await new Promise((resolve) => setTimeout(resolve, this.delay));
    this.active -= 1;
    return { exitCode: 0, stdout: "done", stderr: "", turns: 2, messages: 3, changedFiles: ["x.ts"], diffLines: 10, upstreamSignals: this.signals, sessionId: context.sessionId ?? "executor-session" };
  }
}

const validator: ValidatorAdapter = {
  async validate(plan) { return plan.validation.commands.map((entry) => ({ command: entry.command, exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 })); },
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "myclaude-scheduler-test-"));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  roots.push(root);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workspace);
  await writeFile(join(workspace, "x.ts"), "export const x = 1;\n");
  await exec("git", ["init", "-q"], { cwd: workspace });
  await exec("git", ["add", "."], { cwd: workspace });
  await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init"], { cwd: workspace });
  const fingerprint = await computeWorkspaceFingerprint(workspace);
  const store = new TaskStore(state);
  return { root, workspace, fingerprint, store };
}

async function plannedTask(store: TaskStore, workspace: string, fingerprint: string, overrides = {}) {
  const task = await store.createTask({ objective: "Implement the requested test change", workspace });
  await store.submitPlan(makePlan({ taskId: task.id, workspace, baseFingerprint: fingerprint, ...overrides }));
  return task;
}

async function settled(scheduler: TaskScheduler, id: string) {
  await new Promise<void>((resolve) => {
    const listener = (settledId: string) => { if (settledId === id) { scheduler.off("settled", listener); resolve(); } };
    scheduler.on("settled", listener);
  });
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("TaskScheduler", () => {
  it("runs deterministic validation and only the scheduler marks passed", async () => {
    const { store, workspace, fingerprint } = await fixture();
    const task = await plannedTask(store, workspace, fingerprint);
    const scheduler = new TaskScheduler(store, new FakeExecutor(), validator);
    const wait = settled(scheduler, task.id);
    await scheduler.enqueue(task.id);
    await wait;
    expect((await store.getTask(task.id)).state).toBe("passed");
    expect((await store.getEvidence(task.id)).validation[0].exitCode).toBe(0);
  });

  it("rejects a stale plan before execution", async () => {
    const { store, workspace, fingerprint } = await fixture();
    const task = await plannedTask(store, workspace, fingerprint);
    await writeFile(join(workspace, "x.ts"), "export const x = 2;\n");
    const scheduler = new TaskScheduler(store, new FakeExecutor(), validator);
    await expect(scheduler.enqueue(task.id)).rejects.toThrow(/stale plan/);
  });

  it("supports bounded concurrency then degrades to one on upstream throttle", async () => {
    const { store, workspace, fingerprint } = await fixture();
    const executor = new FakeExecutor(20, ["throttle"]);
    const scheduler = new TaskScheduler(store, executor, validator, { concurrency: 3 });
    const tasks = await Promise.all([1, 2, 3].map(() => plannedTask(store, workspace, fingerprint)));
    const waits = tasks.map((task) => settled(scheduler, task.id));
    await Promise.all(tasks.map((task) => scheduler.enqueue(task.id)));
    await Promise.all(waits);
    expect(executor.maximum).toBe(3);
    expect(scheduler.status().effectiveConcurrency).toBe(1);
  });

  it("enters reviewing and reuses the executor session for a repair", async () => {
    const { store, workspace, fingerprint } = await fixture();
    const executor = new FakeExecutor();
    const scheduler = new TaskScheduler(store, executor, validator);
    const task = await plannedTask(store, workspace, fingerprint, { risk: "high", review: { policy: "adaptive" } });
    let wait = settled(scheduler, task.id);
    await scheduler.enqueue(task.id);
    await wait;
    expect((await store.getTask(task.id)).state).toBe("reviewing");
    wait = settled(scheduler, task.id);
    await scheduler.applyReview(task.id, {
      schemaVersion: "myclaude.review/v1", taskId: task.id, reviewer: { provider: "human" }, verdict: "request_changes",
      summary: "repair", findings: [], repairInstructions: ["fix issue"], createdAt: new Date().toISOString(),
    });
    await wait;
    expect(executor.sessions[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(executor.sessions[1]).toBe(executor.sessions[0]);
    expect((await store.getTask(task.id)).state).toBe("reviewing");
  });
});
