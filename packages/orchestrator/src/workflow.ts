import type { MyClaudeClient } from "./client.js";
import type { MyClaudePlan } from "./schemas.js";
import { TERMINAL_TASK_STATES } from "./schemas.js";
import type { PlannerAdapter } from "./planners.js";

type WorkflowClient = Pick<MyClaudeClient, "waitTask" | "getEvidence" | "submitReview" | "cancelTask">;

/** Wait for executor settlement without invoking a paid reviewer. */
export async function waitForExecution(
  client: Pick<MyClaudeClient, "waitTask" | "getEvidence" | "cancelTask">,
  plan: MyClaudePlan,
  options: { deadlineMs?: number; waitSliceMs?: number } = {},
) {
  const deadline = Date.now() + (options.deadlineMs ?? (plan.execution.budgets.timeoutMinutes + 5) * 60_000);
  while (Date.now() < deadline) {
    const task = await client.waitTask(plan.taskId, options.waitSliceMs ?? 300_000);
    if (TERMINAL_TASK_STATES.has(task.state) || task.state === "reviewing") {
      return { task, evidence: await client.getEvidence(plan.taskId) };
    }
  }
  await client.cancelTask(plan.taskId);
  throw new Error("executor wait exceeded its deadline");
}

/** Drive the bounded plan -> execute -> review -> repair loop using one planner session. */
export async function runAutomaticWorkflow(
  client: WorkflowClient,
  plan: MyClaudePlan,
  planner: PlannerAdapter,
  options: { deadlineMs?: number; waitSliceMs?: number } = {},
) {
  const deadline = Date.now() + (options.deadlineMs ?? (plan.execution.budgets.timeoutMinutes + 5) * 60_000);
  let plannerSession = plan.planner.sessionId;
  while (Date.now() < deadline) {
    const task = await client.waitTask(plan.taskId, options.waitSliceMs ?? 300_000);
    if (["passed", "blocked", "cancelled"].includes(task.state)) return { task, evidence: await client.getEvidence(plan.taskId) };
    if (plan.review.policy === "never" && ["partial", "failed"].includes(task.state)) {
      return { task, evidence: await client.getEvidence(plan.taskId) };
    }
    if (["reviewing", "partial", "failed"].includes(task.state)) {
      const evidence = await client.getEvidence(plan.taskId);
      const reviewed = await planner.review({ plan, evidence, sessionId: plannerSession });
      plannerSession = reviewed.sessionId;
      const afterReview = await client.submitReview(plan.taskId, reviewed.artifact);
      if (["passed", "blocked", "cancelled"].includes(afterReview.state)) return { task: afterReview, evidence: await client.getEvidence(plan.taskId) };
      continue;
    }
    if (TERMINAL_TASK_STATES.has(task.state)) return { task, evidence: await client.getEvidence(plan.taskId) };
  }
  await client.cancelTask(plan.taskId);
  throw new Error(`automatic planner/executor loop exceeded its deadline`);
}
