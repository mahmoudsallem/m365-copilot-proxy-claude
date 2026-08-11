import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskStore } from "./store.js";
import { makePlan } from "./test-helpers.js";

const roots: string[] = [];
async function storeFixture() {
  const root = await mkdtemp(join(tmpdir(), "myclaude-store-test-"));
  roots.push(root);
  const store = new TaskStore(root);
  const task = await store.createTask({ objective: "Implement the requested test change", workspace: "/tmp/test-workspace" });
  const plan = makePlan({ taskId: task.id });
  return { root, store, task, plan };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("TaskStore", () => {
  it("uses private modes, immutable plans, and a verifiable event chain", async () => {
    const { root, store, task, plan } = await storeFixture();
    await store.submitPlan(plan);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(join(store.taskDirectory(task.id), "plan.json"))).mode & 0o777).toBe(0o600);
    await expect(store.submitPlan({ ...plan, title: "Changed" })).rejects.toThrow(/immutable/);
    const events = await store.readEvents(task.id);
    expect(events.map((event) => event.type)).toEqual(["task.created", "plan.submitted"]);
    expect(events[1].previousHash).toBe(events[0].hash);
  });

  it("detects plan and event tampering", async () => {
    const { store, task, plan } = await storeFixture();
    await store.submitPlan(plan);
    const planPath = join(store.taskDirectory(task.id), "plan.json");
    await writeFile(planPath, (await readFile(planPath, "utf8")).replace("Test task", "Tampered"));
    await expect(store.getPlan(task.id)).rejects.toThrow(/SHA-256/);
    const eventPath = join(store.taskDirectory(task.id), "events.jsonl");
    await writeFile(eventPath, (await readFile(eventPath, "utf8")).replace('"sequence":1', '"sequence":9'));
    await expect(store.readEvents(task.id)).rejects.toThrow(/chain is invalid/);
  });

  it("imports a standalone immutable plan idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "myclaude-store-test-"));
    roots.push(root);
    const store = new TaskStore(root);
    const plan = makePlan();
    await store.ensureTaskForPlan(plan);
    const first = await store.submitPlan(plan);
    const second = await store.submitPlan(plan);
    expect(first.id).toBe(plan.taskId);
    expect(second.planSha256).toBe(first.planSha256);
  });

  it("redacts credential-shaped process output before durable evidence", async () => {
    const { store, task } = await storeFixture();
    await store.setEvidence(task.id, {
      taskId: task.id,
      state: "executing",
      executor: { exitCode: 1, stdout: "Bearer abcdefghijklmnop", stderr: "password=hunter2", turns: 1, messages: 1, changedFiles: [], upstreamSignals: [] },
      validation: [], reviews: [], unresolvedRisks: [],
    });
    const body = await readFile(join(store.taskDirectory(task.id), "evidence.json"), "utf8");
    expect(body).not.toContain("hunter2");
    expect(body).not.toContain("abcdefghijklmnop");
    expect(body).toContain("[REDACTED]");
  });
});
