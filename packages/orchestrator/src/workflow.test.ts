import { describe, expect, it, vi } from "vitest";
import type { MyClaudeClient } from "./client.js";
import type { PlannerAdapter } from "./planners.js";
import type { TaskRecord } from "./schemas.js";
import { makePlan } from "./test-helpers.js";
import { runAutomaticWorkflow, waitForExecution } from "./workflow.js";

describe("automatic CLI workflow", () => {
  it("reuses one planner session across review and repair until verified", async () => {
    const plan = makePlan({ planner: { provider: "claude", sessionId: "planner-session" }, review: { policy: "adaptive" } });
    const reviewing = task(plan.taskId, "reviewing");
    const repairing = task(plan.taskId, "repairing");
    const passed = task(plan.taskId, "passed");
    const client = {
      waitTask: vi.fn().mockResolvedValueOnce(reviewing).mockResolvedValueOnce(reviewing),
      getEvidence: vi.fn().mockResolvedValue({ taskId: plan.taskId, state: "reviewing", validation: [], reviews: [], unresolvedRisks: [] }),
      submitReview: vi.fn().mockResolvedValueOnce(repairing).mockResolvedValueOnce(passed),
      cancelTask: vi.fn(),
    } as unknown as MyClaudeClient;
    const sessions: Array<string | undefined> = [];
    const planner = {
      provider: "claude",
      async createPlan() { throw new Error("unused"); },
      async review(input) {
        sessions.push(input.sessionId);
        const requestChanges = sessions.length === 1;
        return {
          sessionId: "planner-session",
          artifact: {
            schemaVersion: "myclaude.review/v1", taskId: plan.taskId, reviewer: { provider: "claude", sessionId: "planner-session" },
            verdict: requestChanges ? "request_changes" : "approve", summary: requestChanges ? "repair" : "verified", findings: [],
            repairInstructions: requestChanges ? ["fix it"] : [], createdAt: new Date().toISOString(),
          },
        } as const;
      },
    } as PlannerAdapter;
    const result = await runAutomaticWorkflow(client, plan, planner, { deadlineMs: 5_000, waitSliceMs: 10 });
    expect(result.task.state).toBe("passed");
    expect(sessions).toEqual(["planner-session", "planner-session"]);
    expect(client.submitReview).toHaveBeenCalledTimes(2);
  });

  it("waits for planner-none execution settlement without invoking a reviewer", async () => {
    const plan = makePlan();
    const queued = task(plan.taskId, "queued");
    const passed = task(plan.taskId, "passed");
    const client = {
      waitTask: vi.fn().mockResolvedValueOnce(queued).mockResolvedValueOnce(passed),
      getEvidence: vi.fn().mockResolvedValue({ taskId: plan.taskId, state: "passed", validation: [], reviews: [], unresolvedRisks: [] }),
      cancelTask: vi.fn(),
    } as unknown as MyClaudeClient;
    const result = await waitForExecution(client, plan, { deadlineMs: 5_000, waitSliceMs: 10 });
    expect(result.task.state).toBe("passed");
    expect(client.waitTask).toHaveBeenCalledTimes(2);
    expect(client.cancelTask).not.toHaveBeenCalled();
  });
});

function task(id: string, state: TaskRecord["state"]): TaskRecord {
  return { id, title: "test", objective: "test", workspace: "/tmp", state, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), reviewCycles: 0, repairCycles: 0 };
}
