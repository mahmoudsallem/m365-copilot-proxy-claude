#!/usr/bin/env node

import { redactText as redactHook } from "../myclaude/evidence-lib.mjs";
import { redactText as redactOrchestrator } from "../../packages/orchestrator/dist/index.mjs";

const secrets = [
  "Bearer abcdefghijklmnopqrstuvwxyz",
  "password=hunter2",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJteWNsYXVkZS10ZXN0In0.signaturevalue123",
  "-----BEGIN PRIVATE KEY-----\nvery-secret-material\n-----END PRIVATE KEY-----",
];

for (const secret of secrets) {
  for (const [name, redact] of [["hook", redactHook], ["orchestrator", redactOrchestrator]]) {
    const output = redact(secret);
    if (!output.includes("[REDACTED]")) throw new Error(`${name} redactor did not mark a secret`);
    if (output.includes("hunter2") || output.includes("signaturevalue123") || output.includes("very-secret-material") || output.includes("abcdefghijklmnopqrstuvwxyz")) {
      throw new Error(`${name} redactor leaked secret material`);
    }
  }
}

process.stdout.write("myclaude redaction parity smoke tests passed\n");
