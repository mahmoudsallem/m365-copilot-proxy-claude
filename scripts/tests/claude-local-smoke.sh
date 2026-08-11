#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_ROOT="$(mktemp -d)"
SERVER_PID=""
trap '[[ -z "$SERVER_PID" ]] || kill "$SERVER_PID" 2>/dev/null || true; rm -rf -- "$TEST_ROOT"' EXIT

export HOME="$TEST_ROOT/home"
export XDG_CONFIG_HOME="$TEST_ROOT/config"
export XDG_STATE_HOME="$TEST_ROOT/state"
mkdir -p "$HOME/.local/bin" "$XDG_CONFIG_HOME/m365-copilot-proxy"

PORT_FILE="$TEST_ROOT/port"
node "$ROOT/scripts/tests/claude-local-fake-proxy.mjs" "$PORT_FILE" &
SERVER_PID=$!
for _ in $(seq 1 100); do
  [[ -s "$PORT_FILE" ]] && break
  sleep 0.02
done
PORT_VALUE="$(cat "$PORT_FILE")"

ENV_FILE="$XDG_CONFIG_HOME/m365-copilot-proxy/proxy.env"
printf 'export M365_PROXY_API_KEY=%q\nexport PORT=%q\n' launcher-test-secret "$PORT_VALUE" > "$ENV_FILE"
chmod 600 "$ENV_FILE"

SETTINGS="$XDG_CONFIG_HOME/m365-copilot-proxy/myclaude-hooks.json"
node "$ROOT/scripts/myclaude/install-hooks.mjs" install --profile host-unrestricted --output "$SETTINGS" >/dev/null

FAKE_CLAUDE="$TEST_ROOT/fake-claude"
TRACE="$TEST_ROOT/trace.json"
printf '%s\n' '#!/usr/bin/env bash' \
  'node -e '\''const fs=require("node:fs"); const headers=process.env.ANTHROPIC_CUSTOM_HEADERS||""; const value={args:process.argv.slice(1),base:process.env.ANTHROPIC_BASE_URL,model:process.env.ANTHROPIC_MODEL,tokenOk:process.env.ANTHROPIC_AUTH_TOKEN==="launcher-test-secret",session:(/^X-M365-Session-ID: (.+)$/m.exec(headers)||[])[1],marker:/^X-M365-Claude-Code: 1$/m.test(headers),inheritedAbsent:!headers.includes("stale-session")}; fs.writeFileSync(process.env.LAUNCHER_TRACE,JSON.stringify(value));'\'' -- "$@"' > "$FAKE_CLAUDE"
chmod 700 "$FAKE_CLAUDE"

export M365_LOCAL_ENV="$ENV_FILE"
export MYCLAUDE_HOOK_SETTINGS="$SETTINGS"
export CLAUDE_BIN="$FAKE_CLAUDE"
export LAUNCHER_TRACE="$TRACE"
export MYCLAUDE_SESSION_ID="123e4567-e89b-42d3-a456-426614174000"
export ANTHROPIC_CUSTOM_HEADERS=$'X-M365-Session-ID: stale-session\nX-Direct-Provider-Secret: do-not-forward'
MODEL=gpt-5.5-think-deeper bash "$ROOT/scripts/claude-local.sh" -p "offline smoke" --output-format json >/dev/null

node -e '
  const value=require(process.argv[1]);
  const args=value.args;
  if(!value.tokenOk||!value.marker||!value.inheritedAbsent||value.session!=="123e4567-e89b-42d3-a456-426614174000")process.exit(1);
  if(!value.base.endsWith(":"+process.argv[2])||value.model!=="claude-m365--gpt-5.5-think-deeper")process.exit(1);
  if(!args.includes("--dangerously-skip-permissions")||!args.includes("--settings")||!args.includes("-p"))process.exit(1);
' "$TRACE" "$PORT_VALUE"

printf '%s\n' "claude-local launcher smoke tests passed"
