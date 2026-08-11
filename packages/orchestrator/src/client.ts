import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  CreateTaskInput,
  ExecutionEvidence,
  MyClaudePlan,
  MyClaudeReview,
  TaskEvent,
  TaskRecord,
} from "./schemas.js";
import { TERMINAL_TASK_STATES } from "./schemas.js";

export function defaultStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return env.MYCLAUDE_STATE_ROOT || join(base, "m365-copilot-proxy");
}

export function defaultSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.MYCLAUDE_SOCKET || join(defaultStateRoot(env), "myclauded.sock");
}

export interface ClientOptions {
  socketPath?: string;
  requestTimeoutMs?: number;
}

export class MyClaudeClient {
  readonly socketPath: string;
  private readonly requestTimeoutMs: number;

  constructor(options: ClientOptions = {}) {
    this.socketPath = options.socketPath ?? defaultSocketPath();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 310_000;
  }

  createTask(input: CreateTaskInput): Promise<TaskRecord> {
    return this.call("task_create", input);
  }

  submitPlan(plan: MyClaudePlan): Promise<TaskRecord> {
    return this.call("task_submit_plan", { plan });
  }

  startTask(taskId: string): Promise<TaskRecord> {
    return this.call("task_start", { taskId });
  }

  waitTask(taskId: string, timeoutMs = 30_000): Promise<TaskRecord> {
    return this.call("task_wait", { taskId, timeoutMs });
  }

  getTask(taskId: string): Promise<TaskRecord> {
    return this.call("task_status", { taskId });
  }

  getPlan(taskId: string): Promise<MyClaudePlan> {
    return this.call("task_plan", { taskId });
  }

  listTasks(): Promise<TaskRecord[]> {
    return this.call("task_list", {});
  }

  getEvidence(taskId: string): Promise<ExecutionEvidence> {
    return this.call("task_evidence", { taskId });
  }

  submitReview(taskId: string, review: MyClaudeReview): Promise<TaskRecord> {
    if (taskId !== review.taskId) return Promise.reject(new Error("review task id mismatch"));
    return this.call("task_submit_review", { review });
  }

  requestRepair(taskId: string, instructions: string[] = []): Promise<TaskRecord> {
    return this.call("task_request_repair", { taskId, instructions });
  }

  cancelTask(taskId: string): Promise<TaskRecord> {
    return this.call("task_cancel", { taskId });
  }

  async *events(taskId: string, options: { afterSequence?: number; pollMs?: number; signal?: AbortSignal } = {}): AsyncGenerator<TaskEvent> {
    let after = options.afterSequence ?? 0;
    const pollMs = options.pollMs ?? 500;
    while (!options.signal?.aborted) {
      const events = await this.call<TaskEvent[]>("task_events", { taskId, afterSequence: after });
      for (const event of events) {
        after = event.sequence;
        yield event;
      }
      const task = await this.getTask(taskId);
      if (TERMINAL_TASK_STATES.has(task.state)) return;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  call<T>(method: string, params: unknown): Promise<T> {
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let body = "";
      const timer = setTimeout(() => socket.destroy(new Error(`orchestrator RPC timed out: ${method}`)), this.requestTimeoutMs);
      timer.unref();
      socket.setEncoding("utf8");
      socket.once("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
      socket.on("data", (chunk: string) => { body += chunk; });
      socket.once("error", (error) => { clearTimeout(timer); reject(error); });
      socket.once("end", () => {
        clearTimeout(timer);
        try {
          const response = JSON.parse(body) as { id: string; result?: T; error?: { message: string } };
          if (response.error) reject(new Error(response.error.message));
          else resolve(response.result as T);
        } catch (error) {
          reject(error);
        }
      });
    });
  }
}
