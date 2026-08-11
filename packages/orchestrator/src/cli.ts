#!/usr/bin/env node
import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { chmod, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { MyClaudeClient, defaultSocketPath, defaultStateRoot } from "./client.js";
import { OrchestratorDaemon } from "./daemon.js";
import { runDoctor, fetchModels } from "./diagnostics.js";
import { computeWorkspaceFingerprint } from "./fingerprint.js";
import { IntegrationManager, type IntegrationTarget } from "./integrations.js";
import { ClaudePlannerAdapter, CodexPlannerAdapter, type PlannerAdapter } from "./planners.js";
import { CommandExecutorAdapter, CommandValidatorAdapter, UnavailableExecutor } from "./runner.js";
import { TaskScheduler } from "./scheduler.js";
import { type MyClaudePlan, parsePlan, TERMINAL_TASK_STATES } from "./schemas.js";
import { TaskStore } from "./store.js";
import { errorMessage, secureDirectory, secureWriteFile } from "./util.js";
import { runAutomaticWorkflow, waitForExecution } from "./workflow.js";
import { formatTaskProgress } from "./progress.js";
import { assertManagedHookSettings } from "./hook-settings.js";

const args = process.argv.slice(2);
void main(args).catch((error) => {
  process.stderr.write(`myclaude-orchestrator: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});

async function main(argv: string[]): Promise<void> {
  const [command, subcommand] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") return printHelp();
  if (command === "server") return serverCommand(subcommand, argv.slice(2));
  if (command === "task") return taskCommand(subcommand, argv.slice(2));
  if (command === "integrate") return integrateCommand(subcommand, argv.slice(2));
  if (command === "models") return modelsCommand(argv.slice(1));
  if (command === "doctor") return doctorCommand();
  throw new Error(`unknown command: ${command}`);
}

async function serverCommand(command: string | undefined, argv: string[]): Promise<void> {
  const stateRoot = defaultStateRoot();
  const socketPath = defaultSocketPath();
  const client = new MyClaudeClient({ socketPath });
  if (command === "run") {
    await secureDirectory(stateRoot);
    const executionProfile = process.env.MYCLAUDE_EXECUTION_PROFILE === "host-unrestricted" ? "host-unrestricted" : "guarded";
    if (process.env.MYCLAUDE_EXECUTOR_BIN) {
      await assertManagedHookSettings(process.env.MYCLAUDE_HOOK_SETTINGS, executionProfile);
    }
    const executor = process.env.MYCLAUDE_EXECUTOR_BIN
      ? new CommandExecutorAdapter({
          executable: process.env.MYCLAUDE_EXECUTOR_BIN,
          args: parseJsonArgs(process.env.MYCLAUDE_EXECUTOR_ARGS),
          supportsSessionResume: process.env.MYCLAUDE_EXECUTOR_RESUME !== "0",
        })
      : new UnavailableExecutor();
    const store = new TaskStore(stateRoot);
    const scheduler = new TaskScheduler(store, executor, new CommandValidatorAdapter(), {
      concurrency: Number(process.env.MYCLAUDE_CONCURRENCY || 1),
      executionProfile,
    });
    const daemon = new OrchestratorDaemon({ socketPath, store, scheduler });
    const shutdown = () => void daemon.close();
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    await daemon.start();
    await secureWriteFile(join(stateRoot, "myclauded.pid"), `${process.pid}\n`);
    process.stdout.write(`myclauded listening on ${socketPath}\n`);
    await daemon.waitClosed();
    await rm(join(stateRoot, "myclauded.pid"), { force: true });
    return;
  }
  if (command === "start") {
    try {
      const status = await client.call<Record<string, unknown>>("daemon_status", {});
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      return;
    } catch {
      // Start a detached daemon below.
    }
    await secureDirectory(stateRoot);
    const logPath = join(stateRoot, "myclauded.log");
    const logFd = openSync(logPath, "a", 0o600);
    await chmod(logPath, 0o600);
    const cliPath = fileURLToPath(import.meta.url);
    const child = spawn(process.execPath, [cliPath, "server", "run"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
    child.unref();
    closeSync(logFd);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const status = await client.call<Record<string, unknown>>("daemon_status", {});
        process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error(`daemon did not start; inspect ${logPath}`);
  }
  if (command === "stop") {
    process.stdout.write(`${JSON.stringify(await client.call("daemon_shutdown", {}), null, 2)}\n`);
    return;
  }
  if (command === "pause") {
    process.stdout.write(`${JSON.stringify(await client.call("daemon_pause", {}), null, 2)}\n`);
    return;
  }
  if (command === "resume") {
    process.stdout.write(`${JSON.stringify(await client.call("daemon_resume", {}), null, 2)}\n`);
    return;
  }
  if (command === "status") {
    process.stdout.write(`${JSON.stringify(await client.call("daemon_status", {}), null, 2)}\n`);
    return;
  }
  throw new Error(`unknown server command: ${command ?? "(missing)"}`);
}

async function taskCommand(command: string | undefined, argv: string[]): Promise<void> {
  const client = new MyClaudeClient();
  if (command === "start") {
    const objective = requiredFlag(argv, "--task");
    const workspace = resolve(flag(argv, "--workspace") ?? process.cwd());
    const plannerName = (flag(argv, "--planner") ?? "none") as "claude" | "codex" | "none";
    if (!new Set(["claude", "codex", "none"]).has(plannerName)) throw new Error("--planner must be claude, codex, or none");
    const task = await client.createTask({ objective, workspace, title: flag(argv, "--title") });
    process.stderr.write(formatTaskProgress(task.id, "created"));
    const seed = {
      taskId: task.id,
      title: task.title,
      objective,
      workspace,
      baseFingerprint: await computeWorkspaceFingerprint(workspace),
      risk: (flag(argv, "--risk") ?? "medium") as "low" | "medium" | "high",
      executionProfile: (process.env.MYCLAUDE_EXECUTION_PROFILE === "host-unrestricted" ? "host-unrestricted" : "guarded") as "guarded" | "host-unrestricted",
    };
    let plan: MyClaudePlan;
    let planner: PlannerAdapter | undefined;
    if (plannerName === "none") {
      const validations = flags(argv, "--validate");
      if (validations.length === 0) throw new Error("--planner none requires at least one --validate command");
      plan = parsePlan({
        schemaVersion: "myclaude.plan/v1",
        ...seed,
        planner: { provider: "none" },
        assumptions: [], constraints: [], risk: seed.risk,
        steps: [{ id: "execute", title: task.title, instructions: objective, dependencies: [], expectedFiles: [], acceptanceCriteria: [objective] }],
        validation: { commands: validations.map((validation) => ({ command: validation })) },
        execution: { profile: seed.executionProfile }, review: { policy: "adaptive" }, createdAt: new Date().toISOString(),
      });
    } else {
      planner = plannerName === "claude" ? new ClaudePlannerAdapter() : new CodexPlannerAdapter();
      plan = (await planner.createPlan(seed)).artifact;
    }
    await client.submitPlan(plan);
    process.stderr.write(formatTaskProgress(task.id, "plan-submitted"));
    await client.startTask(task.id);
    process.stderr.write(formatTaskProgress(task.id, "queued"));
    const final = planner ? await runAutomaticWorkflow(client, plan, planner) : await waitForExecution(client, plan);
    process.stdout.write(`${JSON.stringify(final, null, 2)}\n`);
    return;
  }
  if (command === "submit") {
    const path = argv.find((item) => !item.startsWith("-"));
    if (!path) throw new Error("task submit requires a plan JSON file");
    const plan = parsePlan(JSON.parse(await readFile(resolve(path), "utf8")));
    process.stdout.write(`${JSON.stringify(await client.submitPlan(plan), null, 2)}\n`);
    return;
  }
  if (command === "status") {
    const taskId = requiredPositional(argv, "task status requires RUN_ID");
    if (argv.includes("--watch")) {
      while (true) {
        const task = await client.waitTask(taskId, 30_000);
        process.stdout.write(`${JSON.stringify(task)}\n`);
        if (TERMINAL_TASK_STATES.has(task.state) || task.state === "reviewing") break;
      }
    } else {
      const task = await client.getTask(taskId);
      process.stdout.write(`${JSON.stringify(task, null, argv.includes("--json") ? 0 : 2)}\n`);
    }
    return;
  }
  if (command === "list") {
    process.stdout.write(`${JSON.stringify(await client.listTasks(), null, 2)}\n`);
    return;
  }
  if (command === "resume") {
    const taskId = requiredPositional(argv, "task resume requires RUN_ID");
    const current = await client.getTask(taskId);
    const result = current.state === "reviewing" || current.state === "partial" || current.state === "failed" || current.state === "blocked"
      ? await client.requestRepair(taskId, flags(argv, "--instruction"))
      : await client.startTask(taskId);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "review") {
    const taskId = requiredPositional(argv, "task review requires RUN_ID");
    const reviewer = (flag(argv, "--reviewer") ?? "claude") as "claude" | "codex";
    const plan = await client.getPlan(taskId);
    const evidence = await client.getEvidence(taskId);
    const adapter: PlannerAdapter = reviewer === "codex" ? new CodexPlannerAdapter() : new ClaudePlannerAdapter();
    const result = await adapter.review({ plan, evidence, sessionId: plan.planner.provider === reviewer ? plan.planner.sessionId : undefined });
    process.stdout.write(`${JSON.stringify(await client.submitReview(taskId, result.artifact), null, 2)}\n`);
    return;
  }
  if (command === "cancel") {
    process.stdout.write(`${JSON.stringify(await client.cancelTask(requiredPositional(argv, "task cancel requires RUN_ID")), null, 2)}\n`);
    return;
  }
  if (command === "evidence") {
    process.stdout.write(`${JSON.stringify(await client.getEvidence(requiredPositional(argv, "task evidence requires RUN_ID")), null, 2)}\n`);
    return;
  }
  throw new Error(`unknown task command: ${command ?? "(missing)"}`);
}

async function integrateCommand(command: string | undefined, argv: string[]): Promise<void> {
  const target = argv[0] as IntegrationTarget | undefined;
  if (target !== "claude" && target !== "codex") throw new Error("integration target must be claude or codex");
  const mcpPath = fileURLToPath(new URL("./mcp.mjs", import.meta.url));
  const manager = new IntegrationManager(mcpPath);
  const result = command === "add" ? await manager.add(target) : command === "remove" ? await manager.remove(target) : command === "status" ? await manager.status(target) : undefined;
  if (!result) throw new Error(`unknown integrate command: ${command ?? "(missing)"}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function modelsCommand(argv: string[]): Promise<void> {
  const models = await fetchModels();
  if (argv.includes("--json")) process.stdout.write(`${JSON.stringify(models, null, 2)}\n`);
  else for (const model of models) process.stdout.write(`${model.id}\n`);
}

async function doctorCommand(): Promise<void> {
  const checks = await runDoctor({ stateRoot: defaultStateRoot(), socketPath: defaultSocketPath() });
  for (const check of checks) process.stdout.write(`${check.ok ? "ok" : "FAIL"}\t${check.name}\t${check.detail}\n`);
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function flags(argv: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) if (argv[index] === name && argv[index + 1]) values.push(argv[index + 1]);
  return values;
}

function requiredFlag(argv: string[], name: string): string {
  const value = flag(argv, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredPositional(argv: string[], message: string): string {
  const value = argv.find((item) => !item.startsWith("-"));
  if (!value) throw new Error(message);
  return value;
}

function parseJsonArgs(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error("MYCLAUDE_EXECUTOR_ARGS must be a JSON string array");
  return parsed;
}

function printHelp(): void {
  process.stdout.write(`MyClaude verified task orchestrator\n\nCommands:\n  server start|run|stop|pause|resume|status\n  task start --planner claude|codex|none --workspace PATH --task TEXT [--validate COMMAND]\n  task submit PLAN.json\n  task status RUN_ID [--watch|--json]\n  task list\n  task resume RUN_ID [--instruction TEXT]\n  task review RUN_ID --reviewer claude|codex\n  task evidence RUN_ID\n  task cancel RUN_ID\n  integrate add|remove|status claude|codex\n  models [--json]\n  doctor\n\nEnvironment:\n  MYCLAUDE_STATE_ROOT, MYCLAUDE_SOCKET, MYCLAUDE_EXECUTOR_BIN, MYCLAUDE_EXECUTOR_ARGS,\n  MYCLAUDE_EXECUTION_PROFILE=guarded|host-unrestricted, MYCLAUDE_CONCURRENCY=1..4,\n  MYCLAUDE_HOOK_SETTINGS=/absolute/settings.json, MYCLAUDE_EXECUTOR_RESUME=0|1\n`);
}
