#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$TEST_ROOT"' EXIT

catalog="$(node "$ROOT/scripts/bench/verified-catalog.mjs" validate)"
node -e 'const v=JSON.parse(process.argv[1]);if(!v.valid||v.taskCount<30||v.categories.length<10)process.exit(1)' "$catalog"

PASS_RESULTS="$TEST_ROOT/pass.json"
FAIL_RESULTS="$TEST_ROOT/fail.json"
SHADOW_RESULTS="$TEST_ROOT/shadow.json"
CRITICAL_RESULTS="$TEST_ROOT/critical-failure.json"
node "$ROOT/scripts/tests/myclaude-bench-fixture.mjs" certification "$PASS_RESULTS"
node "$ROOT/scripts/tests/myclaude-bench-fixture.mjs" certification-failure "$FAIL_RESULTS"
node "$ROOT/scripts/tests/myclaude-bench-fixture.mjs" shadow "$SHADOW_RESULTS"
node -e '
  const fs=require("fs");const input=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  for(const row of input.runs)if(row.system==="myclaude"&&row.mode==="adaptive"&&row.taskId==="ts-exhaustive-union"){row.status="failed";row.verifierPassed=false}
  fs.writeFileSync(process.argv[2],JSON.stringify(input));
' "$PASS_RESULTS" "$CRITICAL_RESULTS"

node "$ROOT/scripts/bench/verified-analyze.mjs" --results "$PASS_RESULTS" --phase certification --json \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);if(!v.promoted||v.gates.some(g=>!g.pass))process.exit(1)})'
if node "$ROOT/scripts/bench/verified-analyze.mjs" --results "$FAIL_RESULTS" --phase certification >/dev/null 2>&1; then
  printf '%s\n' "expected fabricated-citation gate to fail" >&2
  exit 1
fi
if node "$ROOT/scripts/bench/verified-analyze.mjs" --results "$CRITICAL_RESULTS" --phase certification >/dev/null 2>&1; then
  printf '%s\n' "expected critical-repeat gate to reject five failed repetitions" >&2
  exit 1
fi
node "$ROOT/scripts/bench/verified-analyze.mjs" --results "$SHADOW_RESULTS" --phase shadow --json \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);if(!v.promoted)process.exit(1)})'

printf '%s\n' "myclaude verified bench smoke tests passed"
