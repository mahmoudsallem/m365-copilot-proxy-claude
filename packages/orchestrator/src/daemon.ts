import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { z } from "zod";
import { TaskStore } from "./store.js";
import { TaskScheduler } from "./scheduler.js";
import { parsePlan, parseReview, TERMINAL_TASK_STATES } from "./schemas.js";
import { atomicWriteJson, errorMessage, secureDirectory } from "./util.js";

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

interface DispatchOptions {
  signal?: AbortSignal;
}

export interface OrchestratorDaemonOptions {
  socketPath: string;
  store: TaskStore;
  scheduler: TaskScheduler;
}

export class OrchestratorDaemon {
  private server?: Server;
  private shuttingDown = false;
  private ownsSocket = false;
  private daemonLock?: DaemonLock;
  private readonly connections = new Set<Socket>();
  private lifecycle: "idle" | "starting" | "running" | "closing" | "closed" = "idle";
  private closeOperation?: Promise<void>;
  private readonly closedPromise: Promise<void>;
  private resolveClosed!: () => void;

  constructor(private readonly options: OrchestratorDaemonOptions) {
    this.closedPromise = new Promise((resolve) => { this.resolveClosed = resolve; });
  }

  async start(): Promise<void> {
    if (this.lifecycle !== "idle") throw new Error(`orchestrator daemon cannot start while ${this.lifecycle}`);
    this.lifecycle = "starting";
    try {
      await this.options.store.initialize();
      this.daemonLock = await acquireDaemonLock(this.options.store.stateRoot, this.options.socketPath);
      await this.options.store.reconcile();
      await secureDirectory(dirname(this.options.socketPath));
      await removeStaleSocket(this.options.socketPath);
      this.server = createServer((socket) => this.handleSocket(socket));
      await listenOnSocket(this.server, this.options.socketPath);
      this.ownsSocket = true;
      await chmod(this.options.socketPath, 0o600);
      await this.options.scheduler.recover();
      this.lifecycle = "running";
    } catch (error) {
      try {
        await this.cleanupFailedStart();
        this.lifecycle = "idle";
      } catch (cleanupError) {
        this.lifecycle = "closing";
        throw new AggregateError([error, cleanupError], `daemon startup failed and cleanup was incomplete: ${errorMessage(error)}`);
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.lifecycle === "closed") return;
    if (this.closeOperation) return this.closeOperation;
    if (this.lifecycle === "starting") throw new Error("orchestrator daemon cannot close while it is starting");
    if (this.lifecycle === "idle") {
      this.lifecycle = "closed";
      this.resolveClosed();
      return;
    }
    this.closeOperation = this.performClose();
    try {
      await this.closeOperation;
    } finally {
      this.closeOperation = undefined;
    }
  }

  waitClosed(): Promise<void> { return this.closedPromise; }

  async dispatch(method: string, params: unknown = {}, options: DispatchOptions = {}): Promise<unknown> {
    if (this.lifecycle !== "running") {
      throw Object.assign(new Error(`orchestrator daemon is ${this.lifecycle}; RPC is not available`), { rpcCode: -32002 });
    }
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
        return this.waitTask(
          z.string().uuid().parse(object.taskId),
          z.number().int().min(0).max(300_000).default(30_000).parse(object.timeoutMs),
          options.signal,
        );
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
        await this.options.scheduler.shutdown();
        setTimeout(() => void this.close().catch(() => {}), 10).unref();
        return { shuttingDown: true };
      default:
        throw Object.assign(new Error(`unknown RPC method: ${method}`), { rpcCode: -32601 });
    }
  }

  private handleSocket(socket: Socket): void {
    this.connections.add(socket);
    socket.once("close", () => this.connections.delete(socket));
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
    const controller = new AbortController();
    const abortOnDisconnect = () => controller.abort(new Error("orchestrator RPC client disconnected"));
    socket.once("close", abortOnDisconnect);
    try {
      request = JSON.parse(line) as RpcRequest;
      if (request.id === undefined || typeof request.method !== "string") throw Object.assign(new Error("invalid RPC request"), { rpcCode: -32600 });
      response = { id: request.id, result: await this.dispatch(request.method, request.params, { signal: controller.signal }) };
    } catch (error) {
      response = {
        id: request?.id ?? null,
        error: { code: (error as { rpcCode?: number }).rpcCode ?? -32000, message: errorMessage(error) },
      };
    } finally {
      socket.removeListener("close", abortOnDisconnect);
    }
    socket.end(`${JSON.stringify(response)}\n`);
  }

  private async waitTask(taskId: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw abortError(signal.reason);
    const initial = await this.options.store.getTask(taskId);
    if (TERMINAL_TASK_STATES.has(initial.state) || timeoutMs === 0) return initial;
    return new Promise((resolve, reject) => {
      let settledResult = false;
      const finish = (operation: () => void) => {
        if (settledResult) return;
        settledResult = true;
        cleanup();
        operation();
      };
      const timer = setTimeout(async () => {
        try {
          const task = await this.options.store.getTask(taskId);
          finish(() => resolve(task));
        } catch (error) {
          finish(() => reject(error));
        }
      }, timeoutMs);
      const settled = async (settledId: string) => {
        if (settledId !== taskId) return;
        try {
          const task = await this.options.store.getTask(taskId);
          finish(() => resolve(task));
        } catch (error) {
          finish(() => reject(error));
        }
      };
      const onAbort = () => finish(() => reject(abortError(signal?.reason)));
      const cleanup = () => {
        clearTimeout(timer);
        this.options.scheduler.removeListener("settled", settled);
        signal?.removeEventListener("abort", onAbort);
      };
      this.options.scheduler.on("settled", settled);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      void this.options.store.getTask(taskId).then((latest) => {
        if (TERMINAL_TASK_STATES.has(latest.state) || latest.state === "reviewing") {
          finish(() => resolve(latest));
        }
      }, (error) => {
        finish(() => reject(error));
      });
    });
  }

  private async performClose(): Promise<void> {
    this.lifecycle = "closing";
    this.shuttingDown = true;
    try {
      await this.options.scheduler.shutdown();
      await this.closeOwnedServer();
      this.server = undefined;
      if (this.ownsSocket) await rm(this.options.socketPath, { force: true });
      this.ownsSocket = false;
      await this.daemonLock?.release();
      this.daemonLock = undefined;
      this.lifecycle = "closed";
      this.resolveClosed();
    } catch (error) {
      // Retain the lifetime lock when shutdown is incomplete. A successor must
      // never race a worker or unlink a socket that this daemon may still own.
      this.lifecycle = this.server?.listening ? "running" : "closing";
      this.shuttingDown = this.lifecycle !== "running";
      throw error;
    }
  }

  private async cleanupFailedStart(): Promise<void> {
    // Cleanup is deliberately ownership-aware: a failed contender must not
    // unlink the active daemon's socket or release somebody else's lock.
    await this.closeOwnedServer().catch(() => {});
    this.server = undefined;
    if (this.ownsSocket) await rm(this.options.socketPath, { force: true }).catch(() => {});
    this.ownsSocket = false;
    if (this.daemonLock) {
      await this.daemonLock.release();
      this.daemonLock = undefined;
    }
  }

  private async closeOwnedServer(): Promise<void> {
    const closing = closeServer(this.server);
    for (const socket of this.connections) socket.destroy();
    await closing;
  }
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return Object.assign(new Error("orchestrator RPC cancelled"), { name: "AbortError" });
}

interface DaemonLockOwner {
  schema: "myclaude.daemon-lock/v1";
  token: string;
  pid: number;
  createdAt: string;
  socketPath: string;
}

interface DaemonLock {
  release(): Promise<void>;
}

const LOCK_DIRECTORY_NAME = ".myclauded.lock";

async function acquireDaemonLock(stateRoot: string, socketPath: string): Promise<DaemonLock> {
  const lockPath = join(stateRoot, LOCK_DIRECTORY_NAME);
  for (;;) {
    const token = randomUUID();
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await chmod(lockPath, 0o700);
      const owner: DaemonLockOwner = {
        schema: "myclaude.daemon-lock/v1",
        token,
        pid: process.pid,
        createdAt: new Date().toISOString(),
        socketPath,
      };
      try {
        await atomicWriteJson(join(lockPath, "owner.json"), owner);
      } catch (error) {
        // Do not remove by pathname after ownership metadata failed: an
        // operator could have replaced that path, and deleting it would create
        // the same split-brain race the lifetime lock is meant to prevent.
        throw new Error(`daemon lock metadata could not be written; inspect ${lockPath} before removing it: ${errorMessage(error)}`);
      }
      return {
        release: async () => {
          const current = await readLockOwner(lockPath);
          if (!current || current.token !== token) {
            throw new Error("refusing to release a daemon lock owned by another process");
          }
          await rm(lockPath, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const existing = await readLockOwner(lockPath);
    if (existing && isProcessAlive(existing.pid)) {
      throw new Error(`orchestrator daemon is already running for state root ${stateRoot} (pid ${existing.pid})`);
    }
    // There is no portable inode-CAS primitive in Node's fs API. Automatic
    // path-based stale reclamation can delete a replacement lock under two
    // racing contenders, so fail closed and require explicit operator cleanup.
    const detail = existing ? `left by dead pid ${existing.pid}` : "with incomplete owner metadata";
    throw new Error(`stale orchestrator daemon lock ${detail} at ${lockPath}; remove it only after confirming no daemon is running`);
  }
}

async function readLockOwner(lockPath: string): Promise<DaemonLockOwner | undefined> {
  try {
    const value = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as Partial<DaemonLockOwner>;
    if (value.schema !== "myclaude.daemon-lock/v1"
      || typeof value.token !== "string"
      || !Number.isSafeInteger(value.pid)
      || (value.pid ?? 0) <= 0
      || typeof value.createdAt !== "string"
      || typeof value.socketPath !== "string") return undefined;
    return value as DaemonLockOwner;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function listenOnSocket(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
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
