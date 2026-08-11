#!/usr/bin/env node

import path from "node:path";
import {
  appendEvent,
  mutateState,
  parsePositiveInteger,
  readExternalVerification,
  readJsonStdin,
  redactText,
  resolveRunDirectory,
  sha256,
} from "./evidence-lib.mjs";

const MUTATING_TOOLS = new Set(["Edit", "MultiEdit", "NotebookEdit", "Write"]);
const FILE_TOOLS = new Set(["Edit", "MultiEdit", "NotebookEdit", "Read", "Write"]);
const VERIFY_COMMAND = /(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|build|typecheck|check)\b|\b(?:pytest|vitest|jest|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test|make\s+(?:test|check)|tsc\b[^\n;]*(?:--noEmit|-b)|bash\s+scripts\/tests\/)/i;
const READ_ONLY_COMMAND = /^\s*(?:(?:cd|ls|find|fd|rg|grep|head|tail|cat|pwd|stat|wc|which|type|file|du|tree)\b|sed\s+-n\b|git\s+(?:status|diff|log|show|rev-parse|branch\s+--show-current)\b|node\s+--check\b)/i;
const DANGEROUS_COMMANDS = [
  [/\brm\s+[^\n;&|]*(?:-[A-Za-z]*r[A-Za-z]*f|-[A-Za-z]*f[A-Za-z]*r)\b/i, "recursive forced deletion"],
  [/\bgit\s+reset\s+--hard\b/i, "hard Git reset"],
  [/\bgit\s+clean\s+-[A-Za-z]*f/i, "forced Git clean"],
  [/\bgit\s+push\b[^\n;&|]*(?:--force(?:-with-lease)?|-f\b)/i, "forced Git push"],
  [/\b(?:sudo|su)\b/i, "privilege escalation"],
  [/\b(?:mkfs(?:\.[A-Za-z0-9]+)?|shutdown|reboot|poweroff)\b/i, "host-destructive command"],
  [/\bdd\b[^\n;&|]*\bof=\s*\/dev\//i, "raw device write"],
  [/\b(?:curl|wget)\b[^\n|]*\|\s*(?:ba|z|fi)?sh\b/i, "download piped to a shell"],
  [/\bchmod\s+-R\s+777\b/i, "world-writable recursive chmod"],
  [/\bchown\s+-R\b/i, "recursive ownership change"],
  [/\b(?:git\s+push|npm\s+publish|pnpm\s+publish|yarn\s+npm\s+publish|gh\s+(?:repo\s+delete|release\s+create|pr\s+merge))\b/i, "external write"],
  [/(?:^|[\s"'])~?\/?\.ssh\/|(?:^|[\s"'])~?\/?\.gnupg\/|(?:^|[\s"'])~?\/?\.aws\//i, "credential-store access"],
];

function commandFrom(input) {
  return typeof input?.tool_input?.command === "string" ? input.tool_input.command : "";
}

function filePathsFrom(input) {
  const toolInput = input?.tool_input ?? {};
  return [toolInput.file_path, toolInput.notebook_path, toolInput.path]
    .filter((item) => typeof item === "string" && item.length > 0);
}

function allowedRoots(input) {
  const configured = process.env.MYCLAUDE_ALLOWED_ROOTS
    ? process.env.MYCLAUDE_ALLOWED_ROOTS.split(path.delimiter).filter(Boolean)
    : [];
  const roots = [process.env.MYCLAUDE_WORKSPACE, input.cwd, ...configured]
    .filter((item) => typeof item === "string" && item.length > 0)
    .map((item) => path.resolve(item));
  return [...new Set(roots)];
}

function within(target, root) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function inspectPolicy(input) {
  const toolName = String(input.tool_name ?? "");
  const roots = allowedRoots(input);
  if (FILE_TOOLS.has(toolName)) {
    for (const requestedPath of filePathsFrom(input)) {
      const target = path.resolve(input.cwd || process.cwd(), requestedPath);
      if (!roots.some((root) => within(target, root))) {
        return { risky: true, reason: `file access outside allowed workspace: ${target}` };
      }
      const relativeParts = path.relative(roots.find((root) => within(target, root)), target).split(path.sep);
      if (relativeParts.some((part) => [".git", ".ssh", ".gnupg", ".aws"].includes(part))) {
        return { risky: true, reason: `protected metadata or credential path: ${target}` };
      }
      if (MUTATING_TOOLS.has(toolName) && /(?:^|\/)\.env(?:\.|$)/.test(target.replaceAll(path.sep, "/"))) {
        return { risky: true, reason: "guarded mode does not modify .env files" };
      }
    }
  }
  if (toolName === "Bash" || toolName === "PowerShell") {
    const command = commandFrom(input);
    for (const [pattern, reason] of DANGEROUS_COMMANDS) {
      if (pattern.test(command)) return { risky: true, reason };
    }
  }
  return { risky: false, reason: null };
}

function commandEvidence(command) {
  return {
    commandHash: sha256(command),
    commandPreview: redactText(command, 500),
    classification: isVerificationCommand(command)
      ? "verification"
      : READ_ONLY_COMMAND.test(command)
        ? "read-only"
        : "possibly-mutating",
  };
}

function isVerificationCommand(command) {
  if (!VERIFY_COMMAND.test(command)) return false;
  // A command that tests and then writes is not verification evidence. Accept
  // ordinary test/build chains, but leave pipes, redirects, substitutions, and
  // unclassified chained commands for the external verifier.
  if (/[<>`]|\$\(|\|(?!=)/.test(command)) return false;
  const segments = command.split(/&&|;|\|\|/).map((item) => item.trim()).filter(Boolean);
  return segments.length > 0
    && segments.some((segment) => VERIFY_COMMAND.test(segment))
    && segments.every((segment) => VERIFY_COMMAND.test(segment) || READ_ONLY_COMMAND.test(segment));
}

function resultEvidence(input) {
  const response = input.tool_response;
  if (!response || typeof response !== "object") return { responseHash: sha256(JSON.stringify(response ?? null)) };
  const output = [response.stdout, response.stderr, response.output, response.content]
    .filter((item) => typeof item === "string")
    .join("\n");
  return {
    success: response.success !== false,
    interrupted: Boolean(response.interrupted),
    responseHash: sha256(JSON.stringify(response)),
    outputPreview: output ? redactText(output, 1_000) : undefined,
  };
}

function toolEvidence(input) {
  const toolName = String(input.tool_name ?? "unknown");
  const evidence = {
    event: input.hook_event_name,
    sessionId: input.session_id,
    toolName,
    toolUseId: input.tool_use_id,
    durationMs: input.duration_ms,
    paths: filePathsFrom(input).map((item) => path.resolve(input.cwd || process.cwd(), item)),
  };
  if (toolName === "Bash" || toolName === "PowerShell") Object.assign(evidence, commandEvidence(commandFrom(input)));
  if (input.hook_event_name === "PostToolUse") Object.assign(evidence, resultEvidence(input));
  if (input.hook_event_name === "PostToolUseFailure") {
    evidence.errorType = /^Exit code\s+(\d+)/i.exec(String(input.error ?? ""))?.[1] ?? "unknown";
    evidence.errorHash = sha256(String(input.error ?? ""));
    evidence.errorPreview = redactText(input.error ?? "", 500);
    evidence.interrupted = Boolean(input.is_interrupt);
  }
  return evidence;
}

function handlePreToolUse(input, directory) {
  const profile = process.env.MYCLAUDE_EXECUTION_PROFILE === "host-unrestricted"
    ? "host-unrestricted"
    : "guarded";
  const policy = inspectPolicy(input);
  appendEvent(directory, {
    type: "hook.pre_tool",
    profile,
    policyOutcome: policy.risky ? (profile === "guarded" ? "denied" : "observed") : "clear",
    policyReason: policy.reason,
    ...toolEvidence(input),
  });
  if (policy.risky && profile === "guarded") {
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `MyClaude guarded profile blocked ${policy.reason}. Narrow the operation or request an explicit profile change.`,
      },
    })}\n`);
  }
}

function handlePostToolUse(input, directory) {
  const evidence = toolEvidence(input);
  appendEvent(directory, { type: "hook.tool_result", ...evidence });
  const toolName = String(input.tool_name ?? "");
  const command = commandFrom(input);
  const isVerification = (toolName === "Bash" || toolName === "PowerShell") && isVerificationCommand(command);
  const isReadOnly = (toolName === "Bash" || toolName === "PowerShell") && READ_ONLY_COMMAND.test(command);
  const isMutation = MUTATING_TOOLS.has(toolName)
    || ((toolName === "Bash" || toolName === "PowerShell") && !isReadOnly && !isVerification);
  mutateState(directory, (state) => ({
    ...state,
    schema: "myclaude.hook-state/v1",
    sessionId: input.session_id,
    changedSinceVerification: isVerification ? false : (isMutation || Boolean(state.changedSinceVerification)),
    lastMutationAt: isMutation ? new Date().toISOString() : state.lastMutationAt,
    mutationCount: Number(state.mutationCount ?? 0) + (isMutation ? 1 : 0),
    lastVerification: isVerification ? {
      status: "passed",
      timestamp: new Date().toISOString(),
      commandHash: evidence.commandHash,
      toolUseId: input.tool_use_id,
    } : state.lastVerification,
    stopBlocks: isVerification ? 0 : Number(state.stopBlocks ?? 0),
  }));
}

function handlePostToolUseFailure(input, directory) {
  const evidence = toolEvidence(input);
  appendEvent(directory, { type: "hook.tool_failure", ...evidence });
  const command = commandFrom(input);
  const isVerification = (input.tool_name === "Bash" || input.tool_name === "PowerShell") && isVerificationCommand(command);
  mutateState(directory, (state) => ({
    ...state,
    schema: "myclaude.hook-state/v1",
    sessionId: input.session_id,
    changedSinceVerification: isVerification ? true : Boolean(state.changedSinceVerification),
    lastVerification: isVerification ? {
      status: "failed",
      timestamp: new Date().toISOString(),
      commandHash: evidence.commandHash,
      errorHash: evidence.errorHash,
    } : state.lastVerification,
  }));
}

function externalVerificationPasses(verification, state) {
  if (!verification || verification.status !== "passed") return false;
  const verifiedAt = Date.parse(verification.verifiedAt ?? verification.timestamp ?? "");
  const changedAt = Date.parse(state.lastMutationAt ?? "");
  return Number.isFinite(verifiedAt) && (!Number.isFinite(changedAt) || verifiedAt >= changedAt);
}

function handleStop(input, directory) {
  const maximumBlocks = parsePositiveInteger(process.env.MYCLAUDE_STOP_MAX_BLOCKS, 2, 7);
  const external = readExternalVerification(directory);
  const state = mutateState(directory, (current) => {
    const externallyVerified = externalVerificationPasses(external, current);
    const needsVerification = Boolean(current.changedSinceVerification) && !externallyVerified;
    const previousBlocks = Number(current.stopBlocks ?? 0);
    const mayBlock = needsVerification && previousBlocks < maximumBlocks;
    return {
      ...current,
      schema: "myclaude.hook-state/v1",
      sessionId: input.session_id,
      changedSinceVerification: externallyVerified ? false : Boolean(current.changedSinceVerification),
      stopBlocks: mayBlock ? previousBlocks + 1 : previousBlocks,
      lastStop: {
        timestamp: new Date().toISOString(),
        outcome: mayBlock ? "blocked-for-verification" : needsVerification ? "allowed-unverified-after-limit" : "allowed",
        stopHookActive: Boolean(input.stop_hook_active),
      },
      finalStatus: needsVerification && !mayBlock ? "partial" : (!needsVerification ? "verified" : current.finalStatus),
    };
  });
  const shouldBlock = state.lastStop?.outcome === "blocked-for-verification";
  appendEvent(directory, {
    type: "hook.stop",
    sessionId: input.session_id,
    outcome: state.lastStop?.outcome,
    blockCount: state.stopBlocks,
    maximumBlocks,
    assistantMessageHash: sha256(String(input.last_assistant_message ?? "")),
  });
  if (shouldBlock) {
    process.stdout.write(`${JSON.stringify({
      decision: "block",
      reason: "Changes were made after the last successful verification. Run the relevant tests, lint, typecheck, or build and fix any failure before declaring completion.",
    })}\n`);
  }
}

function handleStopFailure(input, directory) {
  appendEvent(directory, {
    type: "hook.stop_failure",
    sessionId: input.session_id,
    errorType: input.error ?? "unknown",
    errorHash: sha256(String(input.error_details ?? input.last_assistant_message ?? "")),
    errorPreview: redactText(input.error_details ?? input.last_assistant_message ?? "", 500),
  });
  mutateState(directory, (state) => ({
    ...state,
    schema: "myclaude.hook-state/v1",
    sessionId: input.session_id,
    finalStatus: "failed",
    lastFailure: { type: input.error ?? "unknown", timestamp: new Date().toISOString() },
  }));
}

async function main() {
  const input = await readJsonStdin();
  const directory = resolveRunDirectory(input);
  switch (input.hook_event_name) {
    case "PreToolUse": handlePreToolUse(input, directory); break;
    case "PostToolUse": handlePostToolUse(input, directory); break;
    case "PostToolUseFailure": handlePostToolUseFailure(input, directory); break;
    case "Stop": handleStop(input, directory); break;
    case "StopFailure": handleStopFailure(input, directory); break;
    default: throw new Error(`unsupported hook event: ${input.hook_event_name ?? "missing"}`);
  }
}

main().catch((error) => {
  // Never echo hook input or environment values: they may contain credentials.
  process.stderr.write(`myclaude hook error: ${redactText(error.message, 400)}\n`);
  process.exitCode = 1;
});
