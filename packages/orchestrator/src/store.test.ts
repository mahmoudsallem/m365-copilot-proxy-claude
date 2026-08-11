import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assessValidationEvidence, TaskStore } from "./store.js";
import { makePlan } from "./test-helpers.js";
import { atomicWriteJson, sha256 } from "./util.js";

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

  it("reconciles a plan artifact written before its task projection and event", async () => {
    const { store, task, plan } = await storeFixture();
    await atomicWriteJson(join(store.taskDirectory(task.id), "plan.json"), plan);
    expect((await store.getTask(task.id)).state).toBe("draft");

    await store.reconcile();
    await store.reconcile();

    const recovered = await store.getTask(task.id);
    expect(recovered.state).toBe("planned");
    expect(recovered.planSha256).toBe(sha256(plan));
    expect((await store.readEvents(task.id)).filter((event) => event.type === "plan.submitted")).toHaveLength(1);
  });

  it("reconciles and deduplicates a review artifact across every later projection", async () => {
    const { store, task, plan } = await storeFixture();
    await store.submitPlan(plan);
    const review = {
      schemaVersion: "myclaude.review/v1" as const,
      taskId: task.id,
      reviewer: { provider: "claude" as const, sessionId: "review-session" },
      binding: { attemptId: randomUUID(), planSha256: "a".repeat(64), evidenceSha256: "b".repeat(64) },
      verdict: "request_changes" as const,
      summary: "One repair is required",
      findings: [],
      repairInstructions: ["Repair the failing case"],
      createdAt: new Date().toISOString(),
    };
    await atomicWriteJson(join(store.taskDirectory(task.id), "reviews", "001.json"), review);

    await store.reconcile();
    await store.addReview(task.id, review);
    await store.reconcile();

    expect((await store.getTask(task.id)).reviewCycles).toBe(1);
    expect((await store.getEvidence(task.id)).reviews).toEqual([review]);
    expect((await store.readEvents(task.id)).filter((event) => event.type === "review.submitted")).toHaveLength(1);
    await expect(stat(join(store.taskDirectory(task.id), "reviews", "002.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replays finalization journals idempotently from each atomic crash window", async () => {
    for (const completedProjections of [0, 1, 2]) {
      const { store, task, plan } = await storeFixture();
      const planned = await store.submitPlan(plan);
      await store.transition(task.id, "queued");
      await store.transition(task.id, "executing");
      await store.transition(task.id, "validating");
      const attemptId = randomUUID();
      const completedAt = new Date().toISOString();
      const evidence = {
        ...(await store.getEvidence(task.id)),
        taskId: task.id,
        state: "passed" as const,
        attemptId,
        planSha256: planned.planSha256,
        completedAt,
      };
      const operationId = sha256({
        kind: "execution.finalization",
        taskId: task.id,
        state: "passed",
        attemptId,
        planSha256: planned.planSha256,
      });
      await atomicWriteJson(join(store.taskDirectory(task.id), "finalization.pending.json"), {
        schema: "myclaude.finalization/v1",
        operationId,
        taskId: task.id,
        fromState: "validating",
        state: "passed",
        evidence,
        createdAt: completedAt,
      });
      if (completedProjections >= 1) {
        await atomicWriteJson(join(store.taskDirectory(task.id), "evidence.json"), evidence);
      }
      if (completedProjections >= 2) {
        await atomicWriteJson(join(store.taskDirectory(task.id), "task.json"), {
          ...(await store.getTask(task.id)),
          state: "passed",
          updatedAt: completedAt,
        });
      }

      await store.reconcile();
      await store.reconcile();
      // Model a crash after execution.completed was durably appended but before
      // the pending journal unlink reached disk.
      await atomicWriteJson(join(store.taskDirectory(task.id), "finalization.pending.json"), {
        schema: "myclaude.finalization/v1",
        operationId,
        taskId: task.id,
        fromState: "validating",
        state: "passed",
        evidence,
        createdAt: completedAt,
      });
      await store.finalizeExecution(task.id, "passed", evidence);

      expect((await store.getTask(task.id)).state).toBe("passed");
      expect((await store.getEvidence(task.id)).state).toBe("passed");
      expect((await store.readEvents(task.id)).filter((event) => event.type === "execution.completed"
        && (event.data as { operationId?: string }).operationId === operationId)).toHaveLength(1);
      await expect(stat(join(store.taskDirectory(task.id), "finalization.pending.json"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("rejects a cross-task finalization journal without mutating its target", async () => {
    const first = await storeFixture();
    const second = await storeFixture();
    const completedAt = new Date().toISOString();
    const evidence = { ...(await second.store.getEvidence(second.task.id)), state: "failed" as const, completedAt };
    const operationId = sha256({
      kind: "execution.finalization",
      taskId: second.task.id,
      state: "failed",
      attemptId: sha256({ ...evidence, state: undefined, completedAt: undefined }),
      planSha256: undefined,
    });
    await atomicWriteJson(join(first.store.taskDirectory(first.task.id), "finalization.pending.json"), {
      schema: "myclaude.finalization/v1",
      operationId,
      taskId: second.task.id,
      fromState: "draft",
      state: "failed",
      evidence,
      createdAt: completedAt,
    });
    await expect(first.store.reconcile()).rejects.toThrow(/pending execution finalization is invalid/);
    expect((await second.store.getTask(second.task.id)).state).toBe("draft");
  });

  it("redacts credential-shaped process output before durable evidence", async () => {
    const { store, task } = await storeFixture();
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJteWNsYXVkZS10ZXN0In0.signaturevalue123";
    const privateKey = "-----BEGIN PRIVATE KEY-----\nvery-secret-material\n-----END PRIVATE KEY-----";
    await store.setEvidence(task.id, {
      taskId: task.id,
      state: "executing",
      executor: { exitCode: 1, stdout: "Bearer abcdefghijklmnop", stderr: "password=hunter2", turns: 1, messages: 1, changedFiles: [], upstreamSignals: [] },
      validation: [{ command: "pnpm test", exitCode: 1, stdout: jwt, stderr: privateKey, durationMs: 1 }], reviews: [], unresolvedRisks: [],
    });
    const body = await readFile(join(store.taskDirectory(task.id), "evidence.json"), "utf8");
    expect(body).not.toContain("hunter2");
    expect(body).not.toContain("abcdefghijklmnop");
    expect(body).not.toContain("signaturevalue123");
    expect(body).not.toContain("very-secret-material");
    expect(body).toContain("[REDACTED]");
  });

  it("writes a passed verification only for an exact successful validation contract", async () => {
    const { store, task, plan } = await storeFixture();
    const declared = [
      { command: "pnpm test", timeoutMs: 10_000 },
      { command: "pnpm lint", timeoutMs: 10_000 },
    ];
    const exact = declared.map((item) => ({ command: item.command, exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 }));
    expect(assessValidationEvidence(declared, exact)).toEqual({ passed: true, issues: [] });
    await store.submitPlan({ ...plan, validation: { commands: declared } });
    await store.writeVerification(task.id, declared, exact);
    let verification = JSON.parse(await readFile(join(store.taskDirectory(task.id), "verification.json"), "utf8"));
    expect(verification.status).toBe("passed");
    expect(verification.commands).toHaveLength(2);

    await expect(store.writeVerification(task.id, declared, exact.slice(0, 1))).rejects.toThrow(/count mismatch/);
    await expect(store.writeVerification(task.id, declared, [...exact].reverse())).rejects.toThrow(/command mismatch/);
    await expect(store.writeVerification(task.id, declared, exact.map((item, index) => ({ ...item, exitCode: index })))).rejects.toThrow(/did not exit successfully/);
    await store.invalidateVerification(task.id, ["validation result count mismatch"]);
    verification = JSON.parse(await readFile(join(store.taskDirectory(task.id), "verification.json"), "utf8"));
    expect(verification.status).toBe("failed");
  });
});
