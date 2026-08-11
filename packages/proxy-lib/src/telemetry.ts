import { createHash, createHmac, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createLogger } from "@m365-copilot/core";

const log = createLogger("proxy-telemetry");
const SESSION_HASH_KEY = randomBytes(32);
const DISABLED_VALUES = new Set(["0", "false", "off", "disabled", "none", "-"]);
const SENSITIVE_TEXT = /(?:https?|wss?):\/\/|\b(?:authorization|bearer|password|secret|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token)\b|[A-Za-z0-9+/_-]{40,}={0,2}/i;
const SAFE_TEXT = /^[\x20-\x7e]+$/;

let writeTail: Promise<void> = Promise.resolve();
const warnedTargets = new Set<string>();

export interface ProxyTelemetryInput {
  requestedModel: string;
  resolvedModel: string;
  tone: string;
  route: string;
  certification: string;
  serviceVersion?: string;
  upstreamAttempts: number;
  recoveryEvents: readonly string[];
  toolCallCount: number;
  throttle: { current: number; max: number } | null;
  latencyMs: number;
  outputChars: number;
  outputBytes: number;
  clientSessionId?: string;
  stream: boolean;
  terminalOutcome: string;
  httpStatus: number;
  errorType?: string;
}

export interface ProxyTelemetryRecord {
  schema: "m365.proxy.telemetry/v1";
  timestamp: string;
  requested_model: string;
  resolved_model: string;
  tone: string;
  route: string;
  certification: string;
  service_version?: string;
  upstream_attempts: number;
  recovery_events: string[];
  tool_call_count: number;
  throttle: { current: number; max: number; remaining: number; percent: number } | null;
  latency_ms: number;
  output_chars: number;
  output_bytes: number;
  client_session_hash?: string;
  stream: boolean;
  terminal_outcome: string;
  http_status: number;
  error_type?: string;
}

interface TelemetryTarget {
  path: string;
  managedParent: boolean;
}

interface TelemetryEnvironment {
  M365_TELEMETRY?: string;
  M365_TELEMETRY_PATH?: string;
  XDG_STATE_HOME?: string;
}

function disabled(value: string | undefined): boolean {
  return value !== undefined && DISABLED_VALUES.has(value.trim().toLowerCase());
}

function telemetryTarget(env: TelemetryEnvironment = process.env): TelemetryTarget | null {
  if (disabled(env.M365_TELEMETRY)) return null;
  const override = env.M365_TELEMETRY_PATH?.trim();
  if (override && disabled(override)) return null;
  if (override) return { path: resolve(override), managedParent: false };

  const stateRoot = env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  return {
    path: join(stateRoot, "m365-copilot-proxy", "telemetry.jsonl"),
    managedParent: true,
  };
}

/** The active telemetry path, or null when M365_TELEMETRY disables the sink. */
export function getProxyTelemetryPath(env: TelemetryEnvironment = process.env): string | null {
  return telemetryTarget(env)?.path ?? null;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * Keep useful registry labels while ensuring caller-controlled model strings can
 * never smuggle credentials, URLs, source excerpts, or terminal control bytes
 * into the persistent log.
 */
export function safeTelemetryLabel(value: string, maxLength = 192): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    !SAFE_TEXT.test(normalized) ||
    SENSITIVE_TEXT.test(normalized)
  ) {
    return `redacted:${digest(value)}`;
  }
  return normalized;
}

export function hashTelemetrySessionId(sessionId: string): string {
  const hash = createHmac("sha256", SESSION_HASH_KEY)
    .update(sessionId)
    .digest("hex")
    .slice(0, 24);
  return `hmac-sha256:${hash}`;
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function sanitizeThrottle(value: ProxyTelemetryInput["throttle"]): ProxyTelemetryRecord["throttle"] {
  if (!value) return null;
  const current = nonNegativeInteger(value.current);
  const max = nonNegativeInteger(value.max);
  return {
    current,
    max,
    remaining: Math.max(0, max - current),
    percent: max > 0 ? Math.min(100, Math.round((current / max) * 100)) : 0,
  };
}

/** Build the exact allowlisted on-disk record. Request/response text is absent by design. */
export function sanitizeProxyTelemetry(input: ProxyTelemetryInput): ProxyTelemetryRecord {
  return {
    schema: "m365.proxy.telemetry/v1",
    timestamp: new Date().toISOString(),
    requested_model: safeTelemetryLabel(input.requestedModel),
    resolved_model: safeTelemetryLabel(input.resolvedModel),
    tone: safeTelemetryLabel(input.tone),
    route: safeTelemetryLabel(input.route),
    certification: safeTelemetryLabel(input.certification),
    ...(input.serviceVersion
      ? { service_version: safeTelemetryLabel(input.serviceVersion) }
      : {}),
    upstream_attempts: nonNegativeInteger(input.upstreamAttempts),
    recovery_events: input.recoveryEvents
      .slice(0, 32)
      .map((event) => safeTelemetryLabel(event, 96)),
    tool_call_count: nonNegativeInteger(input.toolCallCount),
    throttle: sanitizeThrottle(input.throttle),
    latency_ms: nonNegativeInteger(input.latencyMs),
    output_chars: nonNegativeInteger(input.outputChars),
    output_bytes: nonNegativeInteger(input.outputBytes),
    ...(input.clientSessionId
      ? { client_session_hash: hashTelemetrySessionId(input.clientSessionId) }
      : {}),
    stream: input.stream,
    terminal_outcome: safeTelemetryLabel(input.terminalOutcome, 96),
    http_status: Math.min(599, Math.max(100, nonNegativeInteger(input.httpStatus) || 500)),
    ...(input.errorType ? { error_type: safeTelemetryLabel(input.errorType, 96) } : {}),
  };
}

async function ensurePrivateParent(target: TelemetryTarget): Promise<void> {
  const parent = dirname(target.path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const stat = await lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("telemetry parent is not a real directory");
  }

  if (target.managedParent) {
    // The default leaf belongs exclusively to this application, so tightening a
    // stale installation is safe. Never chmod an arbitrary override directory.
    await chmod(parent, 0o700);
  } else if ((stat.mode & 0o077) !== 0) {
    throw new Error("telemetry override parent must have mode 0700");
  }
}

async function appendRecord(target: TelemetryTarget, record: ProxyTelemetryRecord): Promise<void> {
  await ensurePrivateParent(target);
  try {
    const existing = await lstat(target.path);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error("telemetry target is not a regular file");
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(
    target.path,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollow,
    0o600,
  );
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Queue one append. The returned promise always resolves: observability must
 * never turn a successful (or already-failing) model request into a new failure.
 */
export function recordProxyTelemetry(input: ProxyTelemetryInput): Promise<void> {
  const target = telemetryTarget();
  if (!target) return Promise.resolve();
  const record = sanitizeProxyTelemetry(input);
  const scheduled = writeTail.then(() => appendRecord(target, record));
  writeTail = scheduled.catch((error: any) => {
    if (!warnedTargets.has(target.path)) {
      warnedTargets.add(target.path);
      log.info(`Telemetry append failed; requests will continue without it (${error?.code ?? "unsafe destination"})`);
    }
  });
  return writeTail;
}

/** Wait for all telemetry scheduled in this process; primarily useful at shutdown/tests. */
export function flushProxyTelemetry(): Promise<void> {
  return writeTail;
}
