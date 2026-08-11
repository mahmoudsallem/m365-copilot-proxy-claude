import type { ProcessRunner, ProcessResult } from "./runner.js";
import { NodeProcessRunner } from "./runner.js";

export type IntegrationTarget = "claude" | "codex";

export interface IntegrationStatus {
  target: IntegrationTarget;
  installed: boolean;
  details: string;
}

export class IntegrationManager {
  constructor(
    private readonly mcpEntryPath: string,
    private readonly runner: ProcessRunner = new NodeProcessRunner(),
    private readonly nodeExecutable = process.execPath,
  ) {}

  async add(target: IntegrationTarget): Promise<IntegrationStatus> {
    const request = target === "claude"
      ? { executable: "claude", args: ["mcp", "add", "--scope", "user", "myclaude", "--", this.nodeExecutable, this.mcpEntryPath] }
      : { executable: "codex", args: ["mcp", "add", "myclaude", "--", this.nodeExecutable, this.mcpEntryPath] };
    const result = await this.invoke(request.executable, request.args);
    if (result.exitCode !== 0) throw new Error(`failed to integrate ${target}: ${result.stderr || result.stdout}`);
    return this.status(target);
  }

  async remove(target: IntegrationTarget): Promise<IntegrationStatus> {
    const result = await this.invoke(target, target === "claude" ? ["mcp", "remove", "--scope", "user", "myclaude"] : ["mcp", "remove", "myclaude"]);
    if (result.exitCode !== 0 && !/not found|does not exist|no server/i.test(`${result.stdout}\n${result.stderr}`)) {
      throw new Error(`failed to remove ${target} integration: ${result.stderr || result.stdout}`);
    }
    return this.status(target);
  }

  async status(target: IntegrationTarget): Promise<IntegrationStatus> {
    const result = await this.invoke(target, ["mcp", "get", "myclaude"]);
    return {
      target,
      installed: result.exitCode === 0,
      details: (result.stdout || result.stderr).trim(),
    };
  }

  private invoke(executable: string, args: string[]): Promise<ProcessResult> {
    return this.runner.run({ executable, args, cwd: process.cwd(), env: process.env, timeoutMs: 30_000 });
  }
}
