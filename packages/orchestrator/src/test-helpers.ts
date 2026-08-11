import { randomUUID } from "node:crypto";
import type { MyClaudePlan } from "./schemas.js";

export function makePlan(overrides: Partial<MyClaudePlan> = {}): MyClaudePlan {
  return {
    schemaVersion: "myclaude.plan/v1",
    taskId: randomUUID(),
    title: "Test task",
    objective: "Implement the requested test change",
    workspace: "/tmp/test-workspace",
    baseFingerprint: "git-sha256:test",
    planner: { provider: "none" },
    risk: "low",
    assumptions: [],
    constraints: ["Preserve unrelated changes"],
    steps: [{
      id: "change",
      title: "Make change",
      instructions: "Edit the relevant file",
      dependencies: [],
      expectedFiles: [],
      acceptanceCriteria: ["The requested behavior works"],
    }],
    validation: { commands: [{ command: "true", timeoutMs: 10_000 }] },
    execution: {
      profile: "guarded",
      concurrency: 1,
      budgets: { initialTurns: 40, repairTurns: 12, messages: 80, reviewCycles: 2, timeoutMinutes: 90 },
    },
    review: { policy: "never" },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}
