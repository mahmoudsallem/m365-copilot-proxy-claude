import { describe, expect, it } from "vitest";
import { CommandExecutorAdapter, CommandValidatorAdapter, directPlannerEnvironment, NodeProcessRunner, type ProcessRequest, type ProcessRunner } from "./runner.js";
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

  it("renders dependent steps in topological order with file boundaries", async () => {
    const requests: ProcessRequest[] = [];
    const runner: ProcessRunner = { async run(request) {
      requests.push(request);
      if (request.executable === "git") return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
      return { exitCode: 0, stdout: "{}", stderr: "", durationMs: 1 };
    } };
    const base = makePlan();
    const plan = makePlan({ steps: [
      { ...base.steps[0], id: "second", title: "Second", dependencies: ["first"], expectedFiles: ["src/second.ts"] },
      { ...base.steps[0], id: "first", title: "First", dependencies: [], expectedFiles: ["src/first.ts"] },
    ] });
    await new CommandExecutorAdapter({ executable: "/proxy-claude", runner }).execute({
      plan, phase: "initial", repairInstructions: [], signal: new AbortController().signal,
      maxTurns: 40, maxMessages: 80, runDirectory: "/tmp/run",
    });
    const prompt = requests.find((request) => request.executable === "/proxy-claude")!.stdin!;
    expect(prompt.indexOf("first. First")).toBeLessThan(prompt.indexOf("second. Second"));
    expect(prompt).toContain("Depends on: first");
    expect(prompt).toContain("Expected files: src/second.ts");
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

  it("rejects an already-aborted process request before spawning a child", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled before launch");
    controller.abort(reason);
    await expect(new NodeProcessRunner().run({
      executable: "/definitely-not-a-real-executable",
      args: [],
      cwd: "/tmp",
      timeoutMs: 5_000,
      signal: controller.signal,
    })).rejects.toBe(reason);
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

  it("waits for a SIGTERM-ignoring process tree to be killed before reporting timeout", async () => {
    if (process.platform === "win32") return;
    const started = Date.now();
    await expect(new NodeProcessRunner(100).run({
      executable: process.execPath,
      args: ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      cwd: "/tmp",
      timeoutMs: 250,
    })).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  });

  it("kills a high-volume producer before output can exhaust daemon memory", async () => {
    const started = Date.now();
    await expect(new NodeProcessRunner(100, 1_024, 8_192).run({
      executable: process.execPath,
      args: ["-e", "const block='x'.repeat(4096);while(process.stdout.write(block)){}"],
      cwd: "/tmp",
      timeoutMs: 5_000,
    })).rejects.toThrow(/stdout exceeded 8192 bytes/);
    expect(Date.now() - started).toBeLessThan(5_000);
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

  it("includes staged tracked changes in executor evidence", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const workspace = await mkdtemp(join(tmpdir(), "myclaude-runner-staged-"));
    try {
      const processRunner = new NodeProcessRunner();
      await processRunner.run({ executable: "git", args: ["init", "-q"], cwd: workspace, timeoutMs: 5_000 });
      await writeFile(join(workspace, "tracked.ts"), "one\n");
      await processRunner.run({ executable: "git", args: ["add", "."], cwd: workspace, timeoutMs: 5_000 });
      await processRunner.run({ executable: "git", args: ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"], cwd: workspace, timeoutMs: 5_000 });
      await writeFile(join(workspace, "tracked.ts"), "one\ntwo\n");
      await processRunner.run({ executable: "git", args: ["add", "tracked.ts"], cwd: workspace, timeoutMs: 5_000 });
      const result = await new CommandExecutorAdapter({ executable: "/bin/true", runner: processRunner, supportsSessionResume: false }).execute({
        plan: makePlan({ workspace }), phase: "initial", repairInstructions: [], signal: new AbortController().signal,
        maxTurns: 40, maxMessages: 80, runDirectory: workspace,
      });
      expect(result.changedFiles).toContain("tracked.ts");
      expect(result.diffLines).toBeGreaterThanOrEqual(1);
      expect(result.workspaceFingerprintBefore).toBe(result.workspaceFingerprintAfter);
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

  it("checkpoints and resumes the same session after a max-output response", async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const workspace = await mkdtemp(join(tmpdir(), "myclaude-continuation-"));
    const requests: ProcessRequest[] = [];
    let proxyCalls = 0;
    const runner: ProcessRunner = { async run(request) {
      requests.push(request);
      if (request.executable === "git") return { exitCode: 1, stdout: "", stderr: "not git", durationMs: 1 };
      proxyCalls += 1;
      return proxyCalls === 1
        ? { exitCode: 0, stdout: '{"stop_reason":"max_tokens","num_turns":1}', stderr: "", durationMs: 1 }
        : { exitCode: 0, stdout: '{"stop_reason":"end_turn","num_turns":1}', stderr: "", durationMs: 1 };
    } };
    try {
      const result = await new CommandExecutorAdapter({ executable: "/proxy-claude", runner }).execute({
        plan: makePlan({ workspace }), phase: "initial", repairInstructions: [], signal: new AbortController().signal,
        maxTurns: 40, maxMessages: 80, sessionId: "d7424f0b-0000-4000-8000-000000000002", runDirectory: workspace,
      });
      expect(proxyCalls).toBe(2);
      expect(result.continuations).toBe(1);
      expect(result.truncated).toBe(false);
      expect(result.turns).toBe(2);
      const proxyRequests = requests.filter((request) => request.executable === "/proxy-claude");
      expect(proxyRequests[0].args).toEqual(expect.arrayContaining(["--max-turns", "40"]));
      expect(proxyRequests[1].args).toEqual(expect.arrayContaining(["--max-turns", "39"]));
      expect(proxyRequests[1].args).toEqual(expect.arrayContaining(["--resume", "d7424f0b-0000-4000-8000-000000000002"]));
      expect(proxyRequests[1].stdin).toContain("previous response hit the output limit");
      const checkpoint = JSON.parse(await readFile(result.checkpointFiles![0], "utf8"));
      expect(checkpoint).toMatchObject({ schemaVersion: "myclaude.executor-checkpoint/v1", continuation: 1, reason: "max-output" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("runs validators through a no-network, read-only-host sandbox with a scrubbed environment", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const workspace = await mkdtemp(join(tmpdir(), "myclaude-validator-request-"));
    const requests: ProcessRequest[] = [];
    const runner: ProcessRunner = { async run(request) {
      requests.push(request);
      return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 };
    } };
    const adapter = new CommandValidatorAdapter({
      runner,
      sandboxExecutable: process.execPath,
      env: { PATH: "/safe/bin", HOME: "/home/test", M365_PROXY_API_KEY: "secret", NODE_OPTIONS: "--require=/evil" },
    });
    try {
      const [result] = await adapter.validate(makePlan({ workspace }), new AbortController().signal);
      expect(result.exitCode).toBe(0);
      expect(requests[0].executable).toBe(process.execPath);
      const bindIndex = requests[0].args.indexOf("--bind");
      expect(requests[0].args).toEqual(expect.arrayContaining(["--unshare-net", "--ro-bind", "/", "/", "--clearenv", "--", "pnpm", "test"]));
      expect(requests[0].args[bindIndex + 1]).not.toBe(workspace);
      expect(requests[0].env).not.toHaveProperty("M365_PROXY_API_KEY");
      expect(requests[0].env).not.toHaveProperty("NODE_OPTIONS");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("prevents a repository validator from reading credentials or writing beside the workspace", async () => {
    const { access, mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    if (!await access("/usr/bin/bwrap").then(() => true, () => false)) return;
    const root = await mkdtemp(join(tmpdir(), "myclaude-validator-sandbox-"));
    const workspace = join(root, "workspace");
    const config = join(root, ".config");
    try {
      await mkdir(workspace);
      await mkdir(config);
      await writeFile(join(config, "credential"), "must-not-be-readable");
      const probe = [
        "const fs=require('node:fs');",
        `try{fs.readFileSync(${JSON.stringify(join(config, "credential"))});process.exit(11)}catch{}`,
        `try{fs.writeFileSync(${JSON.stringify(join(root, "outside"))},'bad');process.exit(12)}catch{}`,
      ].join("");
      await writeFile(join(workspace, "package.json"), JSON.stringify({ scripts: { test: "node probe.cjs" } }));
      await writeFile(join(workspace, "probe.cjs"), probe);
      const adapter = new CommandValidatorAdapter({ env: { ...process.env, HOME: root } });
      const [result] = await adapter.validate(makePlan({ workspace }), new AbortController().signal);
      expect(result.exitCode, result.stderr).toBe(0);
      await expect(access(join(root, "outside"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
