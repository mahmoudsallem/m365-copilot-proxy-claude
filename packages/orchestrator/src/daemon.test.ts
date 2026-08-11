import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
});
