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
    expect(launch.stdin).toContain("- pnpm test");
    expect(launch.stdin).toContain("external orchestrator will repeat them independently");
    expect(launch.env).toMatchObject({
      MYCLAUDE_RUN_DIR: "/private/run",
      MYCLAUDE_WORKSPACE: "/tmp/test-workspace",
      MYCLAUDE_EXECUTION_PROFILE: "guarded",
      MYCLAUDE_SESSION_ID: "d7424f0b-0000-4000-8000-000000000001",
    });
  });

  it("scrubs proxy routing and only proxy-derived credentials from direct planner subprocesses", () => {
    const clean = directPlannerEnvironment({
      PATH: "/bin", ANTHROPIC_BASE_URL: "http://proxy", ANTHROPIC_MODEL: "claude-m365--quick",
      M365_PROXY_API_KEY: "proxy-token", ANTHROPIC_AUTH_TOKEN: "proxy-token",
      OPENAI_API_KEY: "real-openai-key", CLAUDE_CODE_USE_BEDROCK: "1", SAFE_VALUE: "kept",
    });
    expect(clean).toEqual({
      PATH: "/bin", OPENAI_API_KEY: "real-openai-key", CLAUDE_CODE_USE_BEDROCK: "1", SAFE_VALUE: "kept",
    });
  });

  it("treats an early-closing child stdin as a normal process result", async () => {
    const result = await new NodeProcessRunner().run({ executable: "/bin/true", args: [], cwd: "/tmp", stdin: "a large prompt".repeat(1000), timeoutMs: 5_000 });
    expect(result.exitCode).toBe(0);
  });

  it("cancels the worker process group so tool subprocesses cannot outlive a task", async () => {
    if (process.platform === "win32") return;
    const { access, mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const workspace = await mkdtemp(join(tmpdir(), "myclaude-process-tree-"));
    const marker = join(workspace, "orphan-marker");
    const grandchild = `setTimeout(()=>require("node:fs").writeFileSync(${JSON.stringify(marker)},"orphan"),600);setInterval(()=>{},1000)`;
    const parent = `const{spawn}=require("node:child_process");spawn(process.execPath,["-e",${JSON.stringify(grandchild)}],{stdio:"ignore"});setInterval(()=>{},1000)`;
    const controller = new AbortController();
    try {
      const execution = new NodeProcessRunner().run({
        executable: process.execPath,
        args: ["-e", parent],
        cwd: workspace,
        timeoutMs: 5_000,
        signal: controller.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      controller.abort();
      await execution;
      await new Promise((resolve) => setTimeout(resolve, 700));
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("includes untracked files and their lines in change evidence", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const workspace = await mkdtemp(join(tmpdir(), "myclaude-runner-test-"));
    try {
      await new NodeProcessRunner().run({ executable: "git", args: ["init", "-q"], cwd: workspace, timeoutMs: 5_000 });
      await writeFile(join(workspace, "new.ts"), "one\ntwo\n");
      const result = await new CommandExecutorAdapter({ executable: "/bin/true", runner: new NodeProcessRunner(), supportsSessionResume: false }).execute({
        plan: makePlan({ workspace }), phase: "initial", repairInstructions: [], signal: new AbortController().signal,
        maxTurns: 40, maxMessages: 80, runDirectory: workspace,
      });
      expect(result.changedFiles).toContain("new.ts");
      expect(result.diffLines).toBeGreaterThanOrEqual(2);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("uses num_turns as the message count when Claude omits messages", async () => {
    const runner: ProcessRunner = { async run(request) {
      if (request.executable === "git") return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
      return { exitCode: 0, stdout: '{"num_turns":7}', stderr: "", durationMs: 1 };
    } };
    const result = await new CommandExecutorAdapter({ executable: "/proxy-claude", runner }).execute({
      plan: makePlan(), phase: "initial", repairInstructions: [], signal: new AbortController().signal,
      maxTurns: 40, maxMessages: 80, runDirectory: "/tmp/run",
    });
    expect(result.turns).toBe(7);
    expect(result.messages).toBe(7);
  });
});
