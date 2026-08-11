import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { MyClaudeClient } from "./client.js";

describe("MyClaudeClient cancellation", () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  it("destroys the Unix socket when an in-flight wait is aborted", async () => {
    const root = await mkdtemp(join(tmpdir(), "myclaude-client-abort-"));
    roots.push(root);
    const socketPath = join(root, "daemon.sock");
    let markRequest!: () => void;
    const requestReceived = new Promise<void>((resolve) => { markRequest = resolve; });
    let markClosed!: () => void;
    const connectionClosed = new Promise<void>((resolve) => { markClosed = resolve; });
    const server = createServer((socket) => {
      socket.once("data", () => markRequest());
      socket.once("close", () => markClosed());
    });
    server.listen(socketPath);
    await once(server, "listening");

    const controller = new AbortController();
    const client = new MyClaudeClient({ socketPath, requestTimeoutMs: 5_000 });
    const waiting = client.waitTask("00000000-0000-4000-8000-000000000001", 300_000, { signal: controller.signal });
    await requestReceived;
    const cancellation = Object.assign(new Error("cancelled by MCP client"), { name: "AbortError" });
    const rejected = expect(waiting).rejects.toBe(cancellation);
    controller.abort(cancellation);
    await rejected;
    await connectionClosed;
    server.close();
    await once(server, "close");
  });

  it("fails immediately when the caller signal was already aborted", async () => {
    const root = await mkdtemp(join(tmpdir(), "myclaude-client-preabort-"));
    roots.push(root);
    const cancellation = Object.assign(new Error("already cancelled"), { name: "AbortError" });
    const controller = new AbortController();
    controller.abort(cancellation);
    const client = new MyClaudeClient({ socketPath: join(root, "missing.sock"), requestTimeoutMs: 5_000 });
    await expect(client.waitTask("00000000-0000-4000-8000-000000000001", 300_000, { signal: controller.signal })).rejects.toBe(cancellation);
  });
});
