#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { readState, verifyLedger } from "./evidence-lib.mjs";

const directory = process.argv[2] ?? process.env.MYCLAUDE_RUN_DIR;
if (!directory || !path.isAbsolute(directory)) {
  process.stderr.write("Usage: evidence-status.mjs /absolute/run/directory\n");
  process.exit(2);
}

const resolved = path.resolve(directory);
const ledgerPath = path.join(resolved, "evidence.jsonl");
const state = readState(resolved);
const ledger = verifyLedger(ledgerPath);
const verificationPath = path.join(resolved, "verification.json");
let verification = null;
if (fs.existsSync(verificationPath)) {
  try { verification = JSON.parse(fs.readFileSync(verificationPath, "utf8")); } catch { verification = { status: "invalid-json" }; }
}

process.stdout.write(`${JSON.stringify({
  schema: "myclaude.evidence-status/v1",
  runDirectory: resolved,
  state,
  externalVerification: verification,
  ledger,
}, null, 2)}\n`);
if (!ledger.valid) process.exitCode = 1;
