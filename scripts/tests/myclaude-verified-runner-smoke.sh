#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$TEST_ROOT"' EXIT

RESULTS="$TEST_ROOT/results.json"
FIXTURE="$ROOT/scripts/tests/fixtures/myclaude-eval-mock.json"

first="$({
  node "$ROOT/scripts/bench/verified-runner.mjs" \
    --output "$RESULTS" \
    --system myclaude \
    --adapter mock \
    --mock-fixture "$FIXTURE" \
    --task mf-cache-key \
    --repeat 2 \
    --repeat 1 \
    --mode adaptive \
    --seed offline-smoke \
    --isolation local \
    --unit-integration-failures 0
} 2>"$TEST_ROOT/runner.stderr")"

node -e '
  const fs=require("node:fs");
  const result=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  if(result.schema!=="myclaude.eval-results/v1")process.exit(1);
  if(result.execution?.sequential!==true||result.execution?.randomized!==true||result.execution?.maxConcurrent!==1)process.exit(1);
  if(result.runs.length!==2||result.runs.some(r=>r.adapter!=="mock"||r.isolation!=="local"||r.status!=="passed"||r.verifierPassed!==true))process.exit(1);
  if(result.runs.map(r=>r.repetition).sort().join(",")!=="1,2")process.exit(1);
' "$RESULTS"

mode="$(stat -c '%a' "$RESULTS")"
[[ "$mode" == "600" ]]
node -e 'const v=JSON.parse(process.argv[1]);if(v.executed!==2)process.exit(1)' "$first"

second="$({
  node "$ROOT/scripts/bench/verified-runner.mjs" \
    --output "$RESULTS" \
    --system myclaude \
    --adapter mock \
    --mock-fixture "$FIXTURE" \
    --task mf-cache-key \
    --repeat 1 \
    --repeat 2 \
    --mode adaptive \
    --seed offline-smoke \
    --isolation local \
    --unit-integration-failures 0 \
    --resume
} 2>"$TEST_ROOT/resume.stderr")"
node -e 'const v=JSON.parse(process.argv[1]);if(v.executed!==0||v.rows!==2)process.exit(1)' "$second"

# Mock evidence exercises the whole fixture -> adapter -> verifier -> results ->
# analyzer path, but it must never be promotable as live certification evidence.
set +e
node "$ROOT/scripts/bench/verified-analyze.mjs" --results "$RESULTS" --phase certification --json >"$TEST_ROOT/report.json"
analyzer_status=$?
set -e
[[ "$analyzer_status" -eq 1 ]]
node -e '
  const fs=require("node:fs");const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const gate=v.gates.find(g=>g.id==="live-isolated-evidence");
  if(v.promoted||!gate||gate.pass)process.exit(1);
' "$TEST_ROOT/report.json"

# Live adapters are opt-in, and certification refuses a host-local verifier
# before it can invoke the configured command.
if node "$ROOT/scripts/bench/verified-runner.mjs" --output "$TEST_ROOT/no-live.json" \
  --system myclaude --adapter command --myclaude-command /bin/true \
  --task mf-cache-key --isolation local >/dev/null 2>&1; then
  printf '%s\n' "command adapter ran without --live" >&2
  exit 1
fi
if node "$ROOT/scripts/bench/verified-runner.mjs" --output "$TEST_ROOT/no-isolation.json" \
  --system myclaude --adapter command --live --myclaude-command /bin/true \
  --task mf-cache-key --phase certification --isolation local >/dev/null 2>&1; then
  printf '%s\n' "live certification accepted a local verifier" >&2
  exit 1
fi

# Fault-bearing tasks fail closed when a deterministic adapter does not report
# the corresponding injected fault event.
FAULT_RESULTS="$TEST_ROOT/fault-results.json"
node "$ROOT/scripts/bench/verified-runner.mjs" \
  --output "$FAULT_RESULTS" --system myclaude --adapter mock \
  --task recover-missing-rg --seed fault-smoke --isolation local >/dev/null
node -e '
  const fs=require("node:fs");const row=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).runs[0];
  if(row.verifierPassed||row.verifier?.details?.unsupportedFaults?.length!==1)process.exit(1);
' "$FAULT_RESULTS"

POLICY_RESULTS="$TEST_ROOT/policy-results.json"
node "$ROOT/scripts/bench/verified-runner.mjs" \
  --output "$POLICY_RESULTS" --system myclaude --adapter mock \
  --mock-fixture "$FIXTURE" --task unsafe-outside-workspace \
  --seed policy-smoke --isolation local >/dev/null
node -e '
  const fs=require("node:fs");const row=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).runs[0];
  if(!row.verifierPassed||row.status!=="passed"||row.verifier?.details?.attemptedPaths?.[0]!=="/tmp/myclaude-escape.txt")process.exit(1);
' "$POLICY_RESULTS"

RESEARCH_RESULTS="$TEST_ROOT/research-results.json"
node "$ROOT/scripts/bench/verified-runner.mjs" \
  --output "$RESEARCH_RESULTS" --system myclaude --adapter mock \
  --mock-fixture "$ROOT/scripts/tests/fixtures/myclaude-eval-research-adversarial.json" \
  --task research-current-primary --mode adaptive --mode standard \
  --seed research-grounding-smoke --isolation local >/dev/null
node -e '
  const fs=require("fs");const body=fs.readFileSync(process.argv[1],"utf8");const value=JSON.parse(body);
  const valid=value.runs.find(row=>row.mode==="adaptive");
  const forged=value.runs.find(row=>row.mode==="standard");
  if(!valid?.verifierPassed||valid.fabricatedCitations!==0)process.exit(1);
  if(forged?.verifierPassed||forged?.fabricatedCitations!==1)process.exit(1);
  if(forged?.verifier?.details?.grounding?.ungrounded?.[0]?.value!=="https://invented.example/fake")process.exit(1);
  if(body.includes("never-persist-this-material")||body.includes("BEGIN PRIVATE KEY"))process.exit(1);
' "$RESEARCH_RESULTS"

node "$ROOT/scripts/tests/myclaude-verified-runner-process-smoke.mjs"

printf '%s\n' "myclaude verified runner smoke tests passed"
