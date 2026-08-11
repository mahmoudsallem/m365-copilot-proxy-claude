#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bash "$ROOT/scripts/setup-local.sh" >/dev/null
# shellcheck disable=SC1091
source "${M365_LOCAL_ENV:-${XDG_CONFIG_HOME:-$HOME/.config}/m365-copilot-proxy/proxy.env}"

PROXY_PORT="${PORT:-4141}"
PROXY_URL="http://127.0.0.1:${PROXY_PORT}"
MODEL="${MODEL:-gpt-5.5-think-deeper}"
CLAUDE_BIN="${CLAUDE_BIN:-${HOME}/.local/bin/claude-anthropic}"
CLAUDE_GATEWAY_MODEL="claude-m365--${MODEL#claude-m365--}"
CLAUDE_SETTINGS="$ROOT/config/claude-m365-settings.json"

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
if [[ -n "${ANTHROPIC_CUSTOM_HEADERS:-}" ]]; then
  export ANTHROPIC_CUSTOM_HEADERS="${ANTHROPIC_CUSTOM_HEADERS}"$'\nX-M365-Claude-Code: 1'
else
  export ANTHROPIC_CUSTOM_HEADERS="X-M365-Claude-Code: 1"
fi
export DISABLE_TELEMETRY=1
export DISABLE_ERROR_REPORTING=1
export DISABLE_BUG_COMMAND=1
unset ANTHROPIC_API_KEY CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX

printf '[claude-local] proxy=%s  model=%s  tools=Bash,Read,Edit,Write,Glob,Grep\n' "$PROXY_URL" "$MODEL" >&2
# Use the --option=value spelling because --tools accepts multiple values; without
# it, a positional prompt can be mistaken for another tool name.
exec "$CLAUDE_BIN" --settings "$CLAUDE_SETTINGS" --model "$CLAUDE_GATEWAY_MODEL" --tools=Bash,Read,Edit,Write,Glob,Grep "$@"
