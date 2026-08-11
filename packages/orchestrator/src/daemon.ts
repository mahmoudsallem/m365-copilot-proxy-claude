import { chmod, rm } from "node:fs/promises";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { z } from "zod";
import { TaskStore } from "./store.js";
import { TaskScheduler } from "./scheduler.js";
import { parsePlan, parseReview, TERMINAL_TASK_STATES } from "./schemas.js";
import { errorMessage, secureDirectory } from "./util.js";

interface RpcRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

interface RpcResponse {
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface OrchestratorDaemonOptions {
  socketPath: string;
  store: TaskStore;
  scheduler: TaskScheduler;
}

export class OrchestratorDaemon {
  private server?: Server;
  private shuttingDown = false;
  private readonly closedPromise: Promise<void>;
  private resolveClosed!: () => void;

  constructor(private readonly options: OrchestratorDaemonOptions) {
    this.closedPromise = new Promise((resolve) => { this.resolveClosed = resolve; });
  }

  async start(): Promise<void> {
    await this.options.store.initialize();
    await secureDirectory(dirname(this.options.socketPath));
    await removeStaleSocket(this.options.socketPath);
    this.server = createServer((socket) => this.handleSocket(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.options.socketPath, () => {
        this.server!.removeListener("error", reject);
        resolve();
      });
    });
    await chmod(this.options.socketPath, 0o600);
    await this.options.scheduler.recover();
  }

  async close(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    await rm(this.options.socketPath, { force: true });
    this.resolveClosed();
  }

  waitClosed(): Promise<void> { return this.closedPromise; }

  async dispatch(method: string, params: unknown = {}): Promise<unknown> {
    const object = z.record(z.string(), z.unknown()).parse(params);
    switch (method) {
      case "task_create":
        return this.options.store.createTask(object as never);
      case "task_submit_plan": {
        const plan = parsePlan(object.plan);
        await this.options.store.ensureTaskForPlan(plan);
        return this.options.store.submitPlan(plan);
      }
      case "task_start":
        return this.options.scheduler.enqueue(z.string().uuid().parse(object.taskId));
      case "task_wait":
        return this.waitTask(z.string().uuid().parse(object.taskId), z.number().int().min(0).max(300_000).default(30_000).parse(object.timeoutMs));
      case "task_status":
        return this.options.store.getTask(z.string().uuid().parse(object.taskId));
      case "task_plan":
        return this.options.store.getPlan(z.string().uuid().parse(object.taskId));
      case "task_list":
        return this.options.store.listTasks();
      case "task_evidence":
        return this.options.store.getEvidence(z.string().uuid().parse(object.taskId));
      case "task_events":
        return this.options.store.readEvents(
          z.string().uuid().parse(object.taskId),
          z.number().int().min(0).default(0).parse(object.afterSequence),
        );
      case "task_submit_review": {
        const review = parseReview(object.review);
        return this.options.scheduler.applyReview(review.taskId, review);
      }
      case "task_request_repair":
        return this.options.scheduler.requestRepair(
          z.string().uuid().parse(object.taskId),
          z.array(z.string().min(1)).default([]).parse(object.instructions),
        );
      case "task_cancel":
        return this.options.scheduler.cancel(z.string().uuid().parse(object.taskId));
      case "daemon_status":
        return { pid: process.pid, socketPath: this.options.socketPath, ...this.options.scheduler.status() };
      case "daemon_pause":
        this.options.scheduler.pause();
        return { paused: true };
      case "daemon_resume":
        this.options.scheduler.resume();
        return { paused: false };
      case "daemon_shutdown":
        setTimeout(() => void this.close(), 10).unref();
        return { shuttingDown: true };
      default:
        throw Object.assign(new Error(`unknown RPC method: ${method}`), { rpcCode: -32601 });
    }
  }

  private handleSocket(socket: Socket): void {
    socket.on("error", () => {
      // A client may disconnect after cancellation/timeout; never crash the daemon on EPIPE.
    });
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 10_000_000) {
        socket.destroy(new Error("RPC request exceeds 10 MB"));
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) void this.respond(socket, line);
      }
    });
  }

  private async respond(socket: Socket, line: string): Promise<void> {
    let request: RpcRequest | undefined;
    let response: RpcResponse;
    try {
      request = JSON.parse(line) as RpcRequest;
      if (request.id === undefined || typeof request.method !== "string") throw Object.assign(new Error("invalid RPC request"), { rpcCode: -32600 });
      response = { id: request.id, result: await this.dispatch(request.method, request.params) };
    } catch (error) {
      response = {
        id: request?.id ?? null,
        error: { code: (error as { rpcCode?: number }).rpcCode ?? -32000, message: errorMessage(error) },
      };
    }
    socket.end(`${JSON.stringify(response)}\n`);
  }

  private async waitTask(taskId: string, timeoutMs: number): Promise<unknown> {
    const initial = await this.options.store.getTask(taskId);
    if (TERMINAL_TASK_STATES.has(initial.state) || timeoutMs === 0) return initial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(async () => {
        cleanup();
        try { resolve(await this.options.store.getTask(taskId)); } catch (error) { reject(error); }
      }, timeoutMs);
      const settled = async (settledId: string) => {
        if (settledId !== taskId) return;
        cleanup();
        try { resolve(await this.options.store.getTask(taskId)); } catch (error) { reject(error); }
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.options.scheduler.removeListener("settled", settled);
      };
      this.options.scheduler.on("settled", settled);
      void this.options.store.getTask(taskId).then((latest) => {
        if (TERMINAL_TASK_STATES.has(latest.state) || latest.state === "reviewing") {
          cleanup();
          resolve(latest);
        }
      }, (error) => {
        cleanup();
        reject(error);
      });
    });
  }
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  const active = await new Promise<boolean>((resolve) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
  if (active) throw new Error(`orchestrator daemon is already listening at ${socketPath}`);
  await rm(socketPath, { force: true });
}
