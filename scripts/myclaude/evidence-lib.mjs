#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const SECRET_KEY = /(?:api[-_]?key|auth(?:orization)?|cookie|credential|mfa|pass(?:word)?|secret|(?:access|refresh|session)[-_]?token|(?:^|_)token(?:$|_))/i;
const SECRET_TEXT_PATTERNS = [
  [/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]"],
  [/\b(?:sk|gh[opusr]|github_pat)_[A-Za-z0-9_\-]{12,}\b/g, "[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]"],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi, "[REDACTED]"],
  [/((?:api[_-]?key|authorization|cookie|mfa|password|secret|token)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]"],
];

export function redactText(value, maxLength = 2_000) {
  let text = String(value ?? "");
  for (const [pattern, replacement] of SECRET_TEXT_PATTERNS) text = text.replace(pattern, replacement);
  if (text.length > maxLength) text = `${text.slice(0, maxLength)}…[${text.length - maxLength} chars omitted]`;
  return text;
}

export function sanitizeValue(value, depth = 0) {
  if (depth > 6) return "[DEPTH_LIMIT]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value !== "object") return String(value);
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    output[key] = SECRET_KEY.test(key) ? "[REDACTED]" : sanitizeValue(item, depth + 1);
  }
  return output;
}

export function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export async function readJsonStdin() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) throw new Error("hook input was empty");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("hook input must be an object");
  return parsed;
}

export function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch {}
  return directory;
}

function safeSessionId(value) {
  const sessionId = String(value ?? "unknown").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  return sessionId || "unknown";
}

export function resolveRunDirectory(input = {}) {
  if (process.env.MYCLAUDE_RUN_DIR) {
    if (!path.isAbsolute(process.env.MYCLAUDE_RUN_DIR)) throw new Error("MYCLAUDE_RUN_DIR must be absolute");
    return privateDirectory(path.resolve(process.env.MYCLAUDE_RUN_DIR));
  }
  const stateBase = process.env.XDG_STATE_HOME
    ? path.resolve(process.env.XDG_STATE_HOME)
    : path.join(os.homedir(), ".local", "state");
  return privateDirectory(path.join(
    stateBase,
    "m365-copilot-proxy",
    "hook-sessions",
    safeSessionId(input.session_id),
  ));
}

function sleep(milliseconds) {
  Atomics.wait(WAIT_BUFFER, 0, 0, milliseconds);
}

function withLock(directory, callback) {
  privateDirectory(directory);
  const lockPath = path.join(directory, ".ledger.lock");
  const deadline = Date.now() + 3_000;
  while (true) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > 30_000) fs.rmdirSync(lockPath);
      } catch {}
      if (Date.now() >= deadline) throw new Error(`timed out acquiring evidence lock: ${lockPath}`);
      sleep(20);
    }
  }
  try {
    return callback();
  } finally {
    try { fs.rmdirSync(lockPath); } catch {}
  }
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export function readState(directory) {
  return readJsonFile(path.join(directory, "hook-state.json"), {});
}

function atomicWriteJsonUnlocked(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(sanitizeValue(value), null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

export function atomicWriteJson(filePath, value) {
  privateDirectory(path.dirname(filePath));
  return withLock(path.dirname(filePath), () => atomicWriteJsonUnlocked(filePath, value));
}

export function mutateState(directory, updater) {
  return withLock(directory, () => {
    const filePath = path.join(directory, "hook-state.json");
    const current = readJsonFile(filePath, {});
    const next = updater({ ...current });
    atomicWriteJsonUnlocked(filePath, next);
    return next;
  });
}

function lastLedgerRecord(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, "utf8").trimEnd();
  if (!content) return null;
  const lastLine = content.slice(content.lastIndexOf("\n") + 1);
  try { return JSON.parse(lastLine); } catch { return null; }
}

export function appendEvent(directory, event) {
  return withLock(directory, () => {
    const filePath = path.join(directory, "evidence.jsonl");
    const previous = lastLedgerRecord(filePath);
    const body = sanitizeValue({
      schema: "myclaude.evidence/v1",
      sequence: Number(previous?.sequence ?? 0) + 1,
      timestamp: new Date().toISOString(),
      previousHash: previous?.hash ?? null,
      ...event,
    });
    const hash = sha256(JSON.stringify(body));
    const record = { ...body, hash };
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    try { fs.chmodSync(filePath, 0o600); } catch {}
    return record;
  });
}

export function verifyLedger(filePath) {
  if (!fs.existsSync(filePath)) return { valid: true, records: 0, lastHash: null, errors: [] };
  const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  let previousHash = null;
  const errors = [];
  for (let index = 0; index < lines.length; index++) {
    let record;
    try { record = JSON.parse(lines[index]); } catch {
      errors.push(`line ${index + 1}: invalid JSON`);
      continue;
    }
    const { hash, ...body } = record;
    if (record.sequence !== index + 1) errors.push(`line ${index + 1}: sequence mismatch`);
    if (body.previousHash !== previousHash) errors.push(`line ${index + 1}: previous hash mismatch`);
    if (sha256(JSON.stringify(body)) !== hash) errors.push(`line ${index + 1}: record hash mismatch`);
    previousHash = hash ?? null;
  }
  return { valid: errors.length === 0, records: lines.length, lastHash: previousHash, errors };
}

export function readExternalVerification(directory) {
  const value = readJsonFile(path.join(directory, "verification.json"), null);
  if (!value || typeof value !== "object") return null;
  return value;
}

export function parsePositiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? Math.min(parsed, maximum) : fallback;
}
