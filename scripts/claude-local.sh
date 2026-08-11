#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bash "$ROOT/scripts/setup-local.sh" >/dev/null
export PATH="$ROOT/.runtime/node/node_modules/node/bin:$PATH"
# shellcheck disable=SC1091
source "${M365_LOCAL_ENV:-${XDG_CONFIG_HOME:-$HOME/.config}/m365-copilot-proxy/proxy.env}"

PROXY_PORT="${PORT:-4141}"
PROXY_URL="http://127.0.0.1:${PROXY_PORT}"
MODEL="${MODEL:-gpt-5.5-think-deeper}"
CLAUDE_BIN="${CLAUDE_BIN:-${HOME}/.local/bin/claude-anthropic}"
CLAUDE_GATEWAY_MODEL="claude-m365--${MODEL#claude-m365--}"
MANAGED_SETTINGS="${MYCLAUDE_HOOK_SETTINGS:-${XDG_CONFIG_HOME:-$HOME/.config}/m365-copilot-proxy/myclaude-hooks.json}"
if [[ -f "$MANAGED_SETTINGS" ]]; then
  CLAUDE_SETTINGS="$MANAGED_SETTINGS"
else
  CLAUDE_SETTINGS="$ROOT/config/claude-m365-settings.json"
fi
MYCLAUDE_SESSION_ID="${MYCLAUDE_SESSION_ID:-$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')}"

if ! curl -fsS -H "Authorization: Bearer ${M365_PROXY_API_KEY}" "$PROXY_URL/v1/models" >/dev/null; then
  printf '%s\n' "[claude-local] no authenticated proxy answering at $PROXY_URL" >&2
  printf '%s\n' "[claude-local] start it in another terminal with: bash '$ROOT/scripts/local.sh' proxy:local" >&2
  exit 1
fi

export ANTHROPIC_BASE_URL="$PROXY_URL"
export ANTHROPIC_AUTH_TOKEN="$M365_PROXY_API_KEY"
export ANTHROPIC_MODEL="$CLAUDE_GATEWAY_MODEL"
export ANTHROPIC_DEFAULT_OPUS_MODEL="$MODEL"
export ANTHROPIC_DEFAULT_SONNET_MODEL="$MODEL"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="$MODEL"
export ANTHROPIC_SMALL_FAST_MODEL="$MODEL"
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
# Claude Code treats model discovery as nonessential traffic. Override a global
# opt-out for this localhost-only wrapper; the individual privacy flags below
# still prevent telemetry, error reporting, and bug-report traffic.
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=
MYCLAUDE_HEADERS=$'X-M365-Claude-Code: 1\nX-M365-Session-ID: '"$MYCLAUDE_SESSION_ID"
# Do not inherit direct-provider custom headers into the localhost gateway. In
# particular, a stale X-M365-Session-ID would defeat per-worker isolation or be
# merged into an invalid comma-separated header by the HTTP client.
export ANTHROPIC_CUSTOM_HEADERS="$MYCLAUDE_HEADERS"
export DISABLE_TELEMETRY=1
export DISABLE_ERROR_REPORTING=1
export DISABLE_BUG_COMMAND=1
unset ANTHROPIC_API_KEY CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX

MYCLAUDE_PROFILE="${MYCLAUDE_EXECUTION_PROFILE:-guarded}"
if [[ -f "$CLAUDE_SETTINGS" ]]; then
  settings_profile="$(node -e 'const fs=require("node:fs");try{const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(v?.env?.MYCLAUDE_EXECUTION_PROFILE||"")}catch{}' "$CLAUDE_SETTINGS")"
  [[ -z "$settings_profile" ]] || MYCLAUDE_PROFILE="$settings_profile"
fi

printf '[claude-local] proxy=%s  model=%s  session=%s  profile=%s  tools=Bash,Read,Edit,Write,Glob,Grep\n' \
  "$PROXY_URL" "$MODEL" "$MYCLAUDE_SESSION_ID" "$MYCLAUDE_PROFILE" >&2
# Use the --option=value spelling because --tools accepts multiple values; without
# it, a positional prompt can be mistaken for another tool name.
permission_args=()
if [[ "$MYCLAUDE_PROFILE" == "host-unrestricted" ]]; then
  permission_args+=(--dangerously-skip-permissions)
fi
exec "$CLAUDE_BIN" --settings "$CLAUDE_SETTINGS" --model "$CLAUDE_GATEWAY_MODEL" \
  --tools=Bash,Read,Edit,Write,Glob,Grep "${permission_args[@]}" "$@"
