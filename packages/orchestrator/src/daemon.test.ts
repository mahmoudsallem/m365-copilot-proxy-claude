import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MyClaudeClient } from "./client.js";
import { OrchestratorDaemon } from "./daemon.js";
import type { ExecutorAdapter, ValidatorAdapter } from "./runner.js";
import { TaskScheduler } from "./scheduler.js";
import { TaskStore } from "./store.js";
import { makePlan } from "./test-helpers.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const executor: ExecutorAdapter = {
  async execute() { return { exitCode: 0, stdout: "done", stderr: "", turns: 1, messages: 1, changedFiles: [], diffLines: 0, upstreamSignals: [], sessionId: "session" }; },
};
const validator: ValidatorAdapter = {
  async validate(plan) { return plan.validation.commands.map((item) => ({ command: item.command, exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 })); },
};

describe("daemon and SDK", () => {
  it("holds an exclusive state-root lock for its full lifetime", async () => {
    const root = await mkdtemp(join(tmpdir(), "myclaude-daemon-lock-test-"));
    roots.push(root);
    const stateRoot = join(root, "state");
    const socketPath = join(root, "daemon.sock");
    const first = new OrchestratorDaemon({
      socketPath,
      store: new TaskStore(stateRoot),
      scheduler: new TaskScheduler(new TaskStore(stateRoot), executor, validator),
    });
    await first.start();
    const lockPath = join(stateRoot, ".myclauded.lock");
    expect((await stat(lockPath)).isDirectory()).toBe(true);

    const secondStore = new TaskStore(stateRoot);
    const second = new OrchestratorDaemon({
      socketPath,
      store: secondStore,
      scheduler: new TaskScheduler(secondStore, executor, validator),
    });
    await expect(second.start()).rejects.toThrow(/already running/);
    const client = new MyClaudeClient({ socketPath, requestTimeoutMs: 5_000 });
    expect((await client.call<{ pid: number }>("daemon_status", {})).pid).toBe(process.pid);
    expect((await stat(socketPath)).isSocket()).toBe(true);

    await first.close();
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans up its socket and lifetime lock when scheduler recovery fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "myclaude-daemon-recover-failure-test-"));
    roots.push(root);
    const stateRoot = join(root, "state");
    const socketPath = join(root, "daemon.sock");
    const failedStore = new TaskStore(stateRoot);
    const failedScheduler = new TaskScheduler(failedStore, executor, validator);
    vi.spyOn(failedScheduler, "recover").mockRejectedValueOnce(new Error("injected recovery failure"));
    const failed = new OrchestratorDaemon({ socketPath, store: failedStore, scheduler: failedScheduler });
    await expect(failed.start()).rejects.toThrow("injected recovery failure");
    await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(stateRoot, ".myclauded.lock"))).rejects.toMatchObject({ code: "ENOENT" });

    const healthyStore = new TaskStore(stateRoot);
    const healthy = new OrchestratorDaemon({
      socketPath,
      store: healthyStore,
      scheduler: new TaskScheduler(healthyStore, executor, validator),
    });
    await healthy.start();
    expect((await stat(socketPath)).isSocket()).toBe(true);
    await healthy.close();
  });

  it("fails closed on a stale lock and starts only after explicit cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "myclaude-daemon-stale-lock-test-"));
    roots.push(root);
    const stateRoot = join(root, "state");
    const lockPath = join(stateRoot, ".myclauded.lock");
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, "owner.json"), `${JSON.stringify({
      schema: "myclaude.daemon-lock/v1",
      token: "stale-owner",
      pid: 2_147_483_647,
      createdAt: "2000-01-01T00:00:00.000Z",
      socketPath: join(root, "old.sock"),
    })}\n`);
    let store = new TaskStore(stateRoot);
    let daemon = new OrchestratorDaemon({
      socketPath: join(root, "new.sock"),
      store,
      scheduler: new TaskScheduler(store, executor, validator),
    });
    await expect(daemon.start()).rejects.toThrow(/stale orchestrator daemon lock/);
    const staleOwner = JSON.parse(await (await import("node:fs/promises")).readFile(join(lockPath, "owner.json"), "utf8"));
    expect(staleOwner.token).toBe("stale-owner");

    await rm(lockPath, { recursive: true });
    store = new TaskStore(stateRoot);
    daemon = new OrchestratorDaemon({
      socketPath: join(root, "new.sock"),
      store,
      scheduler: new TaskScheduler(store, executor, validator),
    });
    await daemon.start();
    const owner = JSON.parse(await (await import("node:fs/promises")).readFile(join(lockPath, "owner.json"), "utf8"));
    expect(owner.pid).toBe(process.pid);
    expect(owner.token).not.toBe("stale-owner");
    await daemon.close();
  });

  it("does not publish RPC methods until scheduler recovery is complete", async () => {
    const root = await mkdtemp(join(tmpdir(), "myclaude-daemon-startup-gate-test-"));
    roots.push(root);
    const stateRoot = join(root, "state");
    const socketPath = join(root, "daemon.sock");
    const store = new TaskStore(stateRoot);
    const scheduler = new TaskScheduler(store, executor, validator);
    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((resolve) => { releaseRecovery = resolve; });
    vi.spyOn(scheduler, "recover").mockImplementationOnce(async () => recoveryGate);
    const daemon = new OrchestratorDaemon({ socketPath, store, scheduler });
    const starting = daemon.start();
    await vi.waitFor(async () => expect((await stat(socketPath)).isSocket()).toBe(true));
    const client = new MyClaudeClient({ socketPath, requestTimeoutMs: 5_000 });
    await expect(client.call("daemon_status", {})).rejects.toThrow(/starting; RPC is not available/);
    releaseRecovery();
    await starting;
    expect(await client.call("daemon_status", {})).toMatchObject({ pid: process.pid });
    await daemon.close();
  });

  it("closes promptly even when a client holds an idle socket open", async () => {
    const root = await mkdtemp(join(tmpdir(), "myclaude-daemon-idle-client-test-"));
    roots.push(root);
    const stateRoot = join(root, "state");
    const socketPath = join(root, "daemon.sock");
    const store = new TaskStore(stateRoot);
    const daemon = new OrchestratorDaemon({ socketPath, store, scheduler: new TaskScheduler(store, executor, validator) });
    await daemon.start();
    const { createConnection } = await import("node:net");
    const idle = createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      idle.once("connect", resolve);
      idle.once("error", reject);
    });
    await expect(Promise.race([
      daemon.close().then(() => "closed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 1_000)),
    ])).resolves.toBe("closed");
    expect(idle.destroyed).toBe(true);
  });

  it("runs a mocked plan end to end over a private Unix socket", async () => {
    const root = await mkdtemp(join(tmpdir(), "myclaude-daemon-test-"));
    roots.push(root);
    const socketPath = join(root, "daemon.sock");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "file.txt"), "initial\n");
    const store = new TaskStore(join(root, "state"));
    const scheduler = new TaskScheduler(store, executor, validator);
    const daemon = new OrchestratorDaemon({ socketPath, store, scheduler });
    await daemon.start();
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    const client = new MyClaudeClient({ socketPath, requestTimeoutMs: 5_000 });
    const task = await client.createTask({ objective: "Implement the requested test change", workspace });
    const { computeWorkspaceFingerprint } = await import("./fingerprint.js");
    const fingerprint = await computeWorkspaceFingerprint(workspace);
    await client.submitPlan(makePlan({ taskId: task.id, workspace, baseFingerprint: fingerprint }));
    await client.startTask(task.id);
    const done = await client.waitTask(task.id, 5_000);
    expect(done.state).toBe("passed");
    expect((await client.getEvidence(task.id)).executor?.sessionId).toBe("session");
    expect((await client.listTasks()).map((item) => item.id)).toContain(task.id);
    await daemon.close();
  });

  it("releases daemon task_wait listeners when the RPC client disconnects", async () => {
    const root = await mkdtemp(join(tmpdir(), "myclaude-daemon-wait-cancel-test-"));
    roots.push(root);
    const socketPath = join(root, "daemon.sock");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const store = new TaskStore(join(root, "state"));
    const scheduler = new TaskScheduler(store, executor, validator);
    const daemon = new OrchestratorDaemon({ socketPath, store, scheduler });
    await daemon.start();
    const client = new MyClaudeClient({ socketPath, requestTimeoutMs: 310_000 });
    const task = await client.createTask({ objective: "Wait without executing", workspace });
    const controller = new AbortController();
    const waiting = client.waitTask(task.id, 300_000, { signal: controller.signal });
    await vi.waitFor(() => expect(scheduler.listenerCount("settled")).toBe(1));
    controller.abort(new Error("cancel test wait"));
    await expect(waiting).rejects.toThrow("cancel test wait");
    await vi.waitFor(() => expect(scheduler.listenerCount("settled")).toBe(0));
    await daemon.close();
  });

  it("recovers an interrupted executing task back into the queue", async () => {
    const root = await mkdtemp(join(tmpdir(), "myclaude-recovery-test-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "file.txt"), "initial\n");
    const store = new TaskStore(join(root, "state"));
    const fingerprint = (await import("./fingerprint.js")).computeWorkspaceFingerprint(workspace);
    const task = await store.createTask({ objective: "Implement the requested test change", workspace });
    await store.submitPlan(makePlan({ taskId: task.id, workspace, baseFingerprint: await fingerprint }));
    await store.transition(task.id, "queued");
    await store.transition(task.id, "executing");
    const scheduler = new TaskScheduler(store, executor, validator);
    const daemon = new OrchestratorDaemon({ socketPath: join(root, "recovery.sock"), store, scheduler });
    const settled = new Promise<void>((resolve) => scheduler.once("settled", () => resolve()));
    await daemon.start();
    await settled;
    expect((await store.getTask(task.id)).state).toBe("passed");
    expect((await store.readEvents(task.id)).some((event) => event.type === "task.recovered")).toBe(true);
    await daemon.close();
  });

  it("quiesces active execution and recovers it once after daemon restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "myclaude-shutdown-test-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "file.txt"), "initial\n");
    const stateRoot = join(root, "state");
    const socketPath = join(root, "shutdown.sock");
    const store = new TaskStore(stateRoot);
    let executions = 0;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const blockingExecutor: ExecutorAdapter = {
      async execute(context) {
        executions += 1;
        started();
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) return resolve();
          context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { exitCode: 1, stdout: "", stderr: "cancelled", turns: 1, messages: 1, changedFiles: [], diffLines: 0, upstreamSignals: [], sessionId: context.sessionId };
      },
    };
    const scheduler = new TaskScheduler(store, blockingExecutor, validator);
    const daemon = new OrchestratorDaemon({ socketPath, store, scheduler });
    await daemon.start();
    const client = new MyClaudeClient({ socketPath, requestTimeoutMs: 5_000 });
    const task = await client.createTask({ objective: "Implement the requested test change", workspace });
    const fingerprint = await (await import("./fingerprint.js")).computeWorkspaceFingerprint(workspace);
    await client.submitPlan(makePlan({ taskId: task.id, workspace, baseFingerprint: fingerprint }));
    await client.startTask(task.id);
    await startedPromise;
    await client.call("daemon_shutdown", {});
    await daemon.waitClosed();
    expect((await store.getTask(task.id)).state).toBe("queued");
    expect(executions).toBe(1);

    let recoveredContext: { sessionId?: string; resumeSession?: boolean } | undefined;
    const recoveryExecutor: ExecutorAdapter = {
      async execute(context) {
        executions += 1;
        recoveredContext = { sessionId: context.sessionId, resumeSession: context.resumeSession };
        return { exitCode: 0, stdout: "recovered", stderr: "", turns: 1, messages: 1, changedFiles: [], diffLines: 0, upstreamSignals: [], sessionId: context.sessionId };
      },
    };
    const secondScheduler = new TaskScheduler(store, recoveryExecutor, validator);
    const secondDaemon = new OrchestratorDaemon({ socketPath, store, scheduler: secondScheduler });
    const recovered = new Promise<void>((resolve) => secondScheduler.once("settled", () => resolve()));
    await secondDaemon.start();
    await recovered;
    expect(executions).toBe(2);
    expect((await store.getTask(task.id)).state).toBe("passed");
    expect(recoveredContext).toEqual({ sessionId: expect.any(String), resumeSession: true });
    expect((await store.readEvents(task.id)).filter((event) => event.type === "task.interrupted")).toHaveLength(1);
    await secondDaemon.close();
  });
});
