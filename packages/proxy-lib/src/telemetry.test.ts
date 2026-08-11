import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  flushProxyTelemetry,
  getProxyTelemetryPath,
  recordProxyTelemetry,
  sanitizeProxyTelemetry,
} from "./telemetry.js";

const originalTelemetry = process.env.M365_TELEMETRY;
const originalPath = process.env.M365_TELEMETRY_PATH;
const tempRoots: string[] = [];

function restore(name: "M365_TELEMETRY" | "M365_TELEMETRY_PATH", value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "m365-telemetry-test-"));
  tempRoots.push(root);
  return root;
}

function input(index = 0) {
  return {
    requestedModel: `quick-${index}`,
    resolvedModel: "quick",
    tone: "Gpt_Quick",
    route: "agentless",
    certification: "experimental",
    serviceVersion: "M365 BizChat/Sydney observed 2026-07-07",
    upstreamAttempts: 2,
    recoveryEvents: ["empty_response_retry"],
    toolCallCount: 1,
    throttle: { current: 18, max: 600 },
    latencyMs: 123,
    outputChars: 20,
    outputBytes: 22,
    clientSessionId: randomUUID(),
    stream: false,
    terminalOutcome: "completed_tool_calls",
    httpStatus: 200,
  };
}

afterEach(async () => {
  await flushProxyTelemetry();
  restore("M365_TELEMETRY", originalTelemetry);
  restore("M365_TELEMETRY_PATH", originalPath);
  while (tempRoots.length) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("redacted JSONL telemetry", () => {
  it("uses the private XDG state location by default and supports disable values", () => {
    expect(getProxyTelemetryPath({ XDG_STATE_HOME: "/safe/state" })).toBe(
      "/safe/state/m365-copilot-proxy/telemetry.jsonl",
    );
    expect(getProxyTelemetryPath({ M365_TELEMETRY: "off" })).toBeNull();
    expect(getProxyTelemetryPath({ M365_TELEMETRY_PATH: "-" })).toBeNull();
  });

  it("persists only allowlisted fields and hashes or redacts sensitive values", () => {
    const sessionId = randomUUID();
    const record = sanitizeProxyTelemetry({
      ...input(),
      requestedModel: "https://example.test/model?access_token=source-snippet",
      serviceVersion: "Bearer top-secret-source-snippet",
      recoveryEvents: ["https://example.test/private/source"],
      clientSessionId: sessionId,
      // Deliberately emulate an untrusted object carrying fields the sink does
      // not define. The runtime sanitizer must omit them too.
      authorization: "Bearer should-never-be-written",
      sourceSnippet: "private retrieved source text",
    } as ReturnType<typeof input> & { authorization: string; sourceSnippet: string });

    const serialized = JSON.stringify(record);
    expect(record.client_session_hash).toMatch(/^hmac-sha256:[0-9a-f]{24}$/);
    expect(record.requested_model).toMatch(/^redacted:/);
    expect(record.service_version).toMatch(/^redacted:/);
    expect(record.recovery_events[0]).toMatch(/^redacted:/);
    expect(serialized).not.toContain(sessionId);
    expect(serialized).not.toContain("example.test");
    expect(serialized).not.toContain("top-secret");
    expect(serialized).not.toContain("private retrieved source text");
    expect(serialized).not.toContain("should-never-be-written");
  });

  it("serializes concurrent appends and enforces mode 0600 with a private parent", async () => {
    const root = await temporaryRoot();
    const parent = join(root, "private");
    const path = join(parent, "events.jsonl");
    delete process.env.M365_TELEMETRY;
    process.env.M365_TELEMETRY_PATH = path;

    await Promise.all(Array.from({ length: 40 }, (_, index) => recordProxyTelemetry(input(index))));
    await flushProxyTelemetry();

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(40);
    const records = lines.map((line) => JSON.parse(line));
    expect(new Set(records.map((record) => record.requested_model)).size).toBe(40);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(parent)).mode & 0o777).toBe(0o700);
  });

  it("never fails the caller when disabled or when an override parent is unsafe", async () => {
    const root = await temporaryRoot();
    const disabledPath = join(root, "disabled.jsonl");
    process.env.M365_TELEMETRY = "0";
    process.env.M365_TELEMETRY_PATH = disabledPath;
    await expect(recordProxyTelemetry(input())).resolves.toBeUndefined();
    await expect(access(disabledPath)).rejects.toMatchObject({ code: "ENOENT" });

    delete process.env.M365_TELEMETRY;
    const publicParent = join(root, "public");
    const unsafePath = join(publicParent, "events.jsonl");
    process.env.M365_TELEMETRY_PATH = unsafePath;
    await mkdir(publicParent, { mode: 0o755 });
    await chmod(publicParent, 0o755);
    await expect(recordProxyTelemetry(input())).resolves.toBeUndefined();
    await expect(access(unsafePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
