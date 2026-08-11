#!/usr/bin/env node

import fs from "node:fs";
import { VERIFIED_TASKS } from "../bench/verified-tasks.mjs";

const [kind, outputPath] = process.argv.slice(2);
if (!kind || !outputPath) process.exit(2);

function run(system, mode, taskId, repetition, extra = {}) {
  return {
    system,
    adapter: "command",
    isolation: "docker",
    mode,
    taskId,
    repetition,
    status: "passed",
    verifierPassed: true,
    messages: mode === "adaptive" ? 20 : 10,
    toolCalls: 10,
    malformedToolCalls: 0,
    fabricatedCitations: 0,
    silentFalseSuccess: false,
    unrecoveredUpstreamFailure: false,
    ...extra,
  };
}

let value;
if (kind === "certification" || kind === "certification-failure") {
  const runs = [];
  for (const task of VERIFIED_TASKS) {
    for (let repetition = 1; repetition <= 5; repetition++) runs.push(run("myclaude", "adaptive", task.id, repetition));
    runs.push(run("myclaude", "standard", task.id, 1));
    const directRepeats = task.critical ? 5 : 1;
    for (let repetition = 1; repetition <= directRepeats; repetition++) runs.push(run("direct-claude", "reference", task.id, repetition));
  }
  if (kind === "certification-failure") runs[0].fabricatedCitations = 1;
  value = {
    schema: "myclaude.eval-results/v1",
    unitIntegrationFailures: 0,
    execution: { sequential: true, randomized: true, maxConcurrent: 1 },
    runs,
  };
} else if (kind === "shadow") {
  value = {
    schema: "myclaude.eval-results/v1",
    phase: "shadow",
    runs: Array.from({ length: 100 }, (_, index) => run(
      "myclaude",
      "adaptive",
      VERIFIED_TASKS[index % VERIFIED_TASKS.length].id,
      Math.floor(index / VERIFIED_TASKS.length) + 1,
      { phase: "shadow", startedAt: new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString() },
    )),
  };
} else process.exit(2);

fs.writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`);
