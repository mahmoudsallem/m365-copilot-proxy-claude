#!/usr/bin/env node

import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCaptured } from "../bench/verified-runner.mjs";

if (process.platform === "win32") {
  process.stdout.write("verified runner process-tree smoke skipped on Windows\n");
  process.exit(0);
}

const root = await mkdtemp(join(tmpdir(), "myclaude-runner-process-"));
const marker = join(root, "orphan-marker");
try {
  const descendant = [
    "process.on('SIGTERM',()=>{});",
    "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'orphan'), 800);",
    "setInterval(() => {}, 1000);",
  ].join("");
  const parent = [
    "const {spawn}=require('node:child_process');",
    `spawn(process.execPath,['-e',${JSON.stringify(descendant)},${JSON.stringify(marker)}],{stdio:'ignore'});`,
    "setInterval(() => {}, 1000);",
  ].join("");
  const result = await spawnCaptured(process.execPath, ["-e", parent], {
    cwd: root,
    env: process.env,
    timeoutMs: 250,
    killGraceMs: 100,
  });
  if (!result.timedOut) throw new Error("expected the process-tree fixture to time out");
  await new Promise((resolve) => setTimeout(resolve, 850));
  if (await access(marker).then(() => true, () => false)) {
    throw new Error("a timed-out adapter descendant survived process-group cleanup");
  }
  process.stdout.write("verified runner process-tree smoke passed\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
