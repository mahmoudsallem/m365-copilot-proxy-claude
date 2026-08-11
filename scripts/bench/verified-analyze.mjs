#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { VERIFIED_TASKS, validateVerifiedCatalog } from "./verified-tasks.mjs";

function parse(argv) {
  const options = { phase: "certification", json: false };
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--json") options.json = true;
    else if (token === "--results" || token === "--phase") {
      const value = argv[++index];
      if (!value) throw new Error(`${token} requires a value`);
      options[token.slice(2)] = value;
    } else throw new Error(`unknown argument: ${token}`);
  }
  if (!options.results) throw new Error("--results is required");
  if (!["certification", "shadow"].includes(options.phase)) throw new Error("--phase must be certification or shadow");
  return options;
}

function validateResults(value) {
  const errors = [];
  if (!value || typeof value !== "object") errors.push("result file must be an object");
  if (value?.schema !== "myclaude.eval-results/v1") errors.push("schema must be myclaude.eval-results/v1");
  if (!Array.isArray(value?.runs)) errors.push("runs must be an array");
  for (const [index, run] of (value?.runs ?? []).entries()) {
    if (!run || typeof run !== "object") errors.push(`runs[${index}] must be an object`);
    if (!run?.taskId || !run?.system) errors.push(`runs[${index}] is missing taskId or system`);
    if (!Number.isInteger(run?.repetition) || run.repetition < 1) errors.push(`runs[${index}] has invalid repetition`);
    if (!Number.isFinite(Number(run?.messages)) || Number(run.messages) < 0) errors.push(`runs[${index}] has invalid messages`);
  }
  return errors;
}

function passed(run) {
  return run.status === "passed" && run.verifierPassed === true;
}

function passRate(runs) {
  return runs.length ? runs.filter(passed).length / runs.length : 0;
}

function taskBalancedPassRate(runs, taskIds) {
  const rates = [...taskIds].map((taskId) => passRate(runs.filter((run) => run.taskId === taskId)));
  return rates.length ? rates.reduce((sum, rate) => sum + rate, 0) / rates.length : 0;
}

function average(runs, field) {
  return runs.length ? runs.reduce((sum, run) => sum + Number(run[field] ?? 0), 0) / runs.length : 0;
}

function gate(id, pass, actual, requirement) {
  return { id, pass: Boolean(pass), actual, requirement };
}

function certification(value) {
  const myClaude = value.runs.filter((run) => run.system === "myclaude" && run.phase !== "shadow");
  const adaptive = myClaude.filter((run) => (run.mode ?? "adaptive") === "adaptive");
  const standard = myClaude.filter((run) => run.mode === "standard");
  const direct = value.runs.filter((run) => run.system === "direct-claude" && run.phase !== "shadow");
  const supportedIds = new Set(VERIFIED_TASKS.map((item) => item.id));
  const adaptiveIds = new Set(adaptive.map((run) => run.taskId));
  const standardIds = new Set(standard.map((run) => run.taskId));
  const directIds = new Set(direct.map((run) => run.taskId));
  const missingTasks = [...supportedIds].filter((id) => !adaptiveIds.has(id));
  const missingStandardTasks = [...supportedIds].filter((id) => !standardIds.has(id));
  const missingDirectTasks = [...supportedIds].filter((id) => !directIds.has(id));
  const insufficientCritical = VERIFIED_TASKS.filter((item) => item.critical).flatMap((item) => {
    const rows = adaptive.filter((run) => run.taskId === item.id);
    const passingRepetitions = new Set(rows.filter(passed).map((run) => run.repetition));
    const failedRepetitions = [...new Set(rows.filter((run) => !passed(run)).map((run) => run.repetition))];
    return passingRepetitions.size >= 5 && failedRepetitions.length === 0
      ? []
      : [{ taskId: item.id, passingRepetitions: passingRepetitions.size, failedRepetitions }];
  });
  const insufficientDirectCritical = VERIFIED_TASKS.filter((item) => item.critical).flatMap((item) => {
    const rows = direct.filter((run) => run.taskId === item.id);
    const passingRepetitions = new Set(rows.filter(passed).map((run) => run.repetition));
    const failedRepetitions = [...new Set(rows.filter((run) => !passed(run)).map((run) => run.repetition))];
    return passingRepetitions.size >= 5 && failedRepetitions.length === 0
      ? []
      : [{ taskId: item.id, passingRepetitions: passingRepetitions.size, failedRepetitions }];
  });
  const silentFalseSuccesses = adaptive.filter((run) => run.silentFalseSuccess === true
    || (run.status === "passed" && run.verifierPassed !== true)).length;
  const malformedToolCalls = adaptive.reduce((sum, run) => sum + Number(run.malformedToolCalls ?? 0), 0);
  const totalToolCalls = adaptive.reduce((sum, run) => sum + Number(run.toolCalls ?? 0), 0);
  const malformedRate = totalToolCalls > 0 ? malformedToolCalls / totalToolCalls : (malformedToolCalls ? 1 : 0);
  const fabricatedCitations = adaptive.reduce((sum, run) => sum + Number(run.fabricatedCitations ?? 0), 0);
  // Compare systems per task rather than by raw row count: critical tasks have
  // more repetitions and must not accidentally dominate either pass rate.
  const adaptiveRate = taskBalancedPassRate(adaptive, supportedIds);
  const directRate = taskBalancedPassRate(direct, supportedIds);
  const relativeRate = directRate > 0 ? adaptiveRate / directRate : 0;
  const adaptiveCost = average(adaptive, "messages");
  const standardCost = average(standard, "messages");
  const costRatio = standardCost > 0 ? adaptiveCost / standardCost : Number.POSITIVE_INFINITY;
  const certificationRows = [...adaptive, ...standard, ...direct];
  const nonLiveOrUnisolated = certificationRows.filter((run) => run.adapter !== "command"
    || run.agentIsolation !== "docker"
    || (run.verifierIsolation ?? run.isolation) !== "docker");
  const gates = [
    gate("catalog-valid", validateVerifiedCatalog().valid, validateVerifiedCatalog().taskCount, ">=30 tasks and all required categories"),
    gate("unit-integration-green", Number(value.unitIntegrationFailures ?? -1) === 0, Number(value.unitIntegrationFailures ?? -1), "0 failures"),
    gate("sequential-randomized", value.execution?.sequential === true && value.execution?.randomized === true && value.execution?.maxConcurrent === 1, value.execution ?? null, "sequential=true, randomized=true, maxConcurrent=1"),
    gate("live-isolated-evidence", certificationRows.length > 0 && nonLiveOrUnisolated.length === 0, { rows: certificationRows.length, rejectedRows: nonLiveOrUnisolated.length }, "every certification row uses adapter=command, agentIsolation=docker, and verifierIsolation=docker"),
    gate("catalog-coverage", missingTasks.length === 0, { covered: adaptiveIds.size, missingTasks }, `all ${VERIFIED_TASKS.length} tasks`),
    gate("critical-repeat", insufficientCritical.length === 0, insufficientCritical, "at least 5 passing repetitions and zero failed repetitions for every critical MyClaude task"),
    gate("standard-coverage", missingStandardTasks.length === 0, { covered: standardIds.size, missingTasks: missingStandardTasks }, `all ${VERIFIED_TASKS.length} tasks`),
    gate("reference-coverage", missingDirectTasks.length === 0 && insufficientDirectCritical.length === 0, { covered: directIds.size, missingTasks: missingDirectTasks, insufficientCritical: insufficientDirectCritical }, "all tasks plus 5 passing and zero failed repetitions for every critical reference task"),
    gate("verified-completion", adaptiveRate >= 0.95, adaptiveRate, ">=0.95"),
    gate("direct-claude-relative", direct.length > 0 && relativeRate >= 0.90, { myclaude: adaptiveRate, directClaude: directRate, ratio: relativeRate, referenceRuns: direct.length }, ">=0.90 of direct Claude pass rate"),
    gate("silent-false-success", adaptive.length >= 150 && silentFalseSuccesses === 0, { runs: adaptive.length, silentFalseSuccesses }, ">=150 runs and 0 silent false-successes"),
    gate("malformed-tools", totalToolCalls > 0 && malformedRate < 0.01, { malformedToolCalls, totalToolCalls, rate: malformedRate }, "<0.01"),
    gate("fabricated-citations", fabricatedCitations === 0, fabricatedCitations, "0"),
    gate("adaptive-cost", standard.length > 0 && costRatio <= 2.5, { adaptiveMessages: adaptiveCost, standardMessages: standardCost, ratio: costRatio, standardRuns: standard.length }, "<=2.5x standard"),
  ];
  return {
    schema: "myclaude.promotion-report/v1",
    phase: "certification",
    promoted: gates.every((item) => item.pass),
    generatedAt: new Date().toISOString(),
    gates,
    metrics: { adaptiveRuns: adaptive.length, standardRuns: standard.length, directRuns: direct.length },
  };
}

function shadow(value) {
  const runs = value.runs.filter((run) => run.system === "myclaude" && (run.phase === "shadow" || value.phase === "shadow"));
  const timestamps = runs.map((run) => Date.parse(run.startedAt ?? "")).filter(Number.isFinite);
  const durationDays = timestamps.length >= 2 ? (Math.max(...timestamps) - Math.min(...timestamps)) / 86_400_000 : 0;
  const silentFalseSuccesses = runs.filter((run) => run.silentFalseSuccess === true
    || (run.status === "passed" && run.verifierPassed !== true)).length;
  const upstreamFailures = runs.filter((run) => run.unrecoveredUpstreamFailure === true).length;
  const upstreamFailureRate = runs.length ? upstreamFailures / runs.length : 1;
  const nonLiveRows = runs.filter((run) => run.adapter !== "command" || run.agentIsolation !== "docker");
  const gates = [
    gate("shadow-live-evidence", runs.length > 0 && nonLiveRows.length === 0, { rows: runs.length, rejectedRows: nonLiveRows.length }, "every shadow row uses adapter=command and agentIsolation=docker"),
    gate("shadow-volume", runs.length >= 100 || durationDays >= 7, { runs: runs.length, durationDays }, ">=100 tasks or >=7 days"),
    gate("shadow-silent-false-success", silentFalseSuccesses === 0, silentFalseSuccesses, "0"),
    gate("shadow-upstream-recovery", runs.length > 0 && upstreamFailureRate < 0.05, { upstreamFailures, runs: runs.length, rate: upstreamFailureRate }, "<0.05"),
  ];
  return {
    schema: "myclaude.promotion-report/v1",
    phase: "shadow",
    promoted: gates.every((item) => item.pass),
    generatedAt: new Date().toISOString(),
    gates,
    metrics: { runs: runs.length, durationDays },
  };
}

function human(report) {
  const lines = [
    `[verified] phase=${report.phase} verdict=${report.promoted ? "PROMOTE" : "DO_NOT_PROMOTE"}`,
    ...report.gates.map((item) => `  ${item.pass ? "PASS" : "FAIL"} ${item.id}: actual=${JSON.stringify(item.actual)} required=${item.requirement}`),
  ];
  return `${lines.join("\n")}\n`;
}

try {
  const options = parse(process.argv.slice(2));
  const resultsPath = path.resolve(options.results);
  const value = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
  const errors = validateResults(value);
  if (errors.length > 0) throw new Error(`invalid result file:\n- ${errors.join("\n- ")}`);
  const report = options.phase === "certification" ? certification(value) : shadow(value);
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : human(report));
  if (!report.promoted) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`verified-analyze: ${error.message}\n`);
  process.exitCode = 2;
}
