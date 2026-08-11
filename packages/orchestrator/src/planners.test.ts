import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ClaudePlannerAdapter, CodexPlannerAdapter } from "./planners.js";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "./runner.js";

const seed = {
  taskId: "fb8ab233-a07f-4fb0-8361-f434670461a4",
  title: "Plan test",
  objective: "Implement the feature",
  workspace: "/tmp",
  baseFingerprint: "fs-sha256:test",
  risk: "low" as const,
  executionProfile: "guarded" as const,
};

function modelArtifact() {
  return {
    assumptions: [], constraints: [], risk: "low",
    steps: [{ id: "one", title: "Implement", instructions: "Make the change", dependencies: [], expectedFiles: [], acceptanceCriteria: ["works"] }],
    validation: { commands: [{ command: "npm test" }] },
    execution: { concurrency: 1, budgets: { initialTurns: 40, repairTurns: 12, messages: 80, reviewCycles: 2, timeoutMinutes: 90 } },
    review: { policy: "never" },
  };
}

describe("planner adapters", () => {
  it("runs direct Claude in plan mode with proxy environment scrubbed", async () => {
    let request!: ProcessRequest;
    const runner: ProcessRunner = { async run(input) {
      request = input;
      return result(JSON.stringify({ structured_output: modelArtifact() }));
    } };
    const previous = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = "http://proxy.invalid";
    try {
      const planned = await new ClaudePlannerAdapter(runner).createPlan(seed);
      expect(planned.artifact.taskId).toBe(seed.taskId);
      expect(planned.artifact.review.policy).toBe("adaptive");
      expect(request.args).toContain("plan");
      expect(request.args).toContain("--json-schema");
      expect(request.env?.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(request.args).toContain("--session-id");
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = previous;
    }
  });

  it("runs Codex read-only, uses schema output, and captures the resumable thread", async () => {
    let request!: ProcessRequest;
    const runner: ProcessRunner = { async run(input) {
      request = input;
      const outputIndex = input.args.indexOf("--output-last-message") + 1;
      await writeFile(input.args[outputIndex], JSON.stringify(modelArtifact()));
      return result('{"type":"thread.started","thread_id":"codex-session"}\n');
    } };
    const planned = await new CodexPlannerAdapter(runner).createPlan(seed);
    expect(planned.sessionId).toBe("codex-session");
    expect(request.args).toContain("read-only");
    expect(request.args).toContain("--output-schema");
    expect(request.args.at(-1)).toBe("-");
  });
});

function result(stdout: string): ProcessResult {
  return { exitCode: 0, stdout, stderr: "", durationMs: 1 };
}
