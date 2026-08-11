#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_ROOT="$(mktemp -d)"
PROXY_PID=""
cleanup() {
  if [[ -n "$PROXY_PID" ]]; then kill "$PROXY_PID" 2>/dev/null || true; fi
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT

export HOME="$TEST_ROOT/home"
export XDG_STATE_HOME="$TEST_ROOT/state"
LEDGER="$TEST_ROOT/ledger"
FIXTURE="$TEST_ROOT/research-fixture.json"

node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({search:{"current package docs":{answer:"Use the current documentation.",sources:[{url:"https://docs.example.test/package?utm_source=mock",title:"Package docs",snippet:"Version 5 is current",provider:"fixture"}]}},fetch:{"https://docs.example.test/package":{answer:"Package content",url:"https://docs.example.test/package",title:"Package docs",snippet:"Version 5 is current"}}},null,2))' "$FIXTURE"

search_output="$(node "$ROOT/scripts/myclaude/myclaude-research.mjs" search --provider mock --fixture "$FIXTURE" --query "current package docs" --ledger "$LEDGER")"
source_url="$(node -e 'const v=JSON.parse(process.argv[1]);process.stdout.write(v.sources[0].url)' "$search_output")"
source_id="$(node -e 'const v=JSON.parse(process.argv[1]);process.stdout.write(v.sources[0].sourceId)' "$search_output")"
[[ "$source_url" == "https://docs.example.test/package" ]]

node "$ROOT/scripts/myclaude/myclaude-research.mjs" validate --ledger "$LEDGER" --require-citations --text "See [$source_id]($source_url) and [[source:$source_id]]." >/dev/null
if node "$ROOT/scripts/myclaude/myclaude-research.mjs" validate --ledger "$LEDGER" --require-citations --text "Bad https://invented.example/fake" >/dev/null 2>&1; then
  printf '%s\n' "expected an ungrounded citation to fail" >&2
  exit 1
fi
node "$ROOT/scripts/myclaude/myclaude-research.mjs" verify --ledger "$LEDGER" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{if(!JSON.parse(s).valid)process.exit(1)})'

PORT_FILE="$TEST_ROOT/port"
node "$ROOT/scripts/tests/myclaude-research-fake-proxy.mjs" "$PORT_FILE" &
PROXY_PID=$!
for _ in $(seq 1 100); do [[ -s "$PORT_FILE" ]] && break; sleep 0.02; done
[[ -s "$PORT_FILE" ]]
PORT="$(<"$PORT_FILE")"
export M365_PROXY_API_KEY=research-test-secret
PROXY_LEDGER="$TEST_ROOT/proxy-ledger"
proxy_output="$(node "$ROOT/scripts/myclaude/myclaude-research.mjs" search --provider proxy --base-url "http://127.0.0.1:$PORT/v1" --query "verified query" --ledger "$PROXY_LEDGER")"
[[ "$(node -e 'const v=JSON.parse(process.argv[1]);process.stdout.write(v.sources[0].url)' "$proxy_output")" == "https://docs.example.test/fact" ]]
! grep -R -q 'research-test-secret' "$PROXY_LEDGER"
if node "$ROOT/scripts/myclaude/myclaude-research.mjs" validate --ledger "$PROXY_LEDGER" --text "https://invented.example/not-a-source" >/dev/null 2>&1; then
  printf '%s\n' "model-generated but unattributed URL was incorrectly accepted" >&2
  exit 1
fi

printf '%s\n' "myclaude research smoke tests passed"
