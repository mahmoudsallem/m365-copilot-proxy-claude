import { describe, expect, it } from "vitest";
import { CommandExecutorAdapter, directPlannerEnvironment, NodeProcessRunner, type ProcessRequest, type ProcessRunner } from "./runner.js";
import { makePlan } from "./test-helpers.js";

describe("process adapters", () => {
  it("persists and resumes the explicit executor session with hook environment", async () => {
    const requests: ProcessRequest[] = [];
    const runner: ProcessRunner = { async run(request) {
      requests.push(request);
      if (request.executable === "git") return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
      return { exitCode: 0, stdout: "{}", stderr: "", durationMs: 1 };
    } };
    const adapter = new CommandExecutorAdapter({ executable: "/proxy-claude", runner });
    await adapter.execute({
      plan: makePlan(), phase: "repair", repairInstructions: ["fix"], signal: new AbortController().signal,
      maxTurns: 12, maxMessages: 80, sessionId: "d7424f0b-0000-4000-8000-000000000001", runDirectory: "/private/run", resumeSession: true,
    });
    const launch = requests.find((request) => request.executable === "/proxy-claude")!;
    expect(launch.args).toContain("--resume");
    expect(launch.args).toContain("d7424f0b-0000-4000-8000-000000000001");
    expect(launch.env).toMatchObject({ MYCLAUDE_RUN_DIR: "/private/run", MYCLAUDE_WORKSPACE: "/tmp/test-workspace", MYCLAUDE_EXECUTION_PROFILE: "guarded" });
  });

  it("scrubs proxy routing and credentials from paid planner subprocesses", () => {
    const clean = directPlannerEnvironment({
      PATH: "/bin", ANTHROPIC_BASE_URL: "http://proxy", ANTHROPIC_AUTH_TOKEN: "proxy-token", OPENAI_API_KEY: "proxy-key", SAFE_VALUE: "kept",
    });
    expect(clean).toEqual({ PATH: "/bin", SAFE_VALUE: "kept" });
  });

  it("treats an early-closing child stdin as a normal process result", async () => {
    const result = await new NodeProcessRunner().run({ executable: "/bin/true", args: [], cwd: "/tmp", stdin: "a large prompt".repeat(1000), timeoutMs: 5_000 });
    expect(result.exitCode).toBe(0);
  });
});
