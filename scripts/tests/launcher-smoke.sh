#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ORIGINAL_PATH="$PATH"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$TEST_ROOT"' EXIT

TEST_HOME="$TEST_ROOT/home"
USER_BIN="$TEST_HOME/.local/bin"
FAKE_BIN="$TEST_ROOT/fake-bin"
CONFIG_DIR="$TEST_HOME/.config/m365-copilot-proxy"
STATE_DIR="$TEST_HOME/.local/state/m365-copilot-proxy"
SETTINGS_FILE="$TEST_HOME/.claude/settings.json"
mkdir -p "$USER_BIN" "$FAKE_BIN" "$(dirname "$SETTINGS_FILE")"

printf '#!/usr/bin/env bash\nprintf "fake-claude:%%s\\n" "$*"\n' > "$FAKE_BIN/claude"
chmod 700 "$FAKE_BIN/claude"
printf '%s\n' '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:4141","ANTHROPIC_MODEL":"gpt-5.5-think-deeper","KEEP_ME":"yes"},"model":"opus[1m]","theme":"dark"}' > "$SETTINGS_FILE"

export HOME="$TEST_HOME"
export PATH="$USER_BIN:$FAKE_BIN:$ORIGINAL_PATH"
export M365_BIN_DIR="$USER_BIN"
export M365_CONFIG_DIR="$CONFIG_DIR"
export M365_STATE_DIR="$STATE_DIR"
export CLAUDE_SETTINGS_FILE="$SETTINGS_FILE"

bash "$ROOT/scripts/m365-control.sh" install-myclaude >/dev/null
[[ -L "$USER_BIN/myclaude" ]]
[[ "$(readlink "$USER_BIN/myclaude")" == "$ROOT/bin/myclaude" ]]
[[ "$(command -v claude)" == "$FAKE_BIN/claude" ]]
[[ "$(claude --version)" == "fake-claude:--version" ]]
"$USER_BIN/myclaude" --help | grep -q 'ordinary `claude` command is never modified'

# The legacy command is now a migration command: it cleans only stale localhost
# settings, installs myclaude, and leaves the real Claude executable untouched.
bash "$ROOT/scripts/m365-control.sh" connect-claude >/dev/null
[[ "$(command -v claude)" == "$FAKE_BIN/claude" ]]
[[ "$(jq -r '.env.KEEP_ME' "$SETTINGS_FILE")" == "yes" ]]
[[ "$(jq -r '.env.ANTHROPIC_BASE_URL // "removed"' "$SETTINGS_FILE")" == "removed" ]]
[[ "$(jq -r '.model' "$SETTINGS_FILE")" == "opus[1m]" ]]

bash "$ROOT/scripts/m365-control.sh" remove-myclaude >/dev/null
[[ ! -e "$USER_BIN/myclaude" ]]
[[ "$(claude)" == "fake-claude:" ]]

# Never overwrite another tool that happens to use the myclaude command name.
printf '#!/usr/bin/env bash\nprintf "unmanaged\\n"\n' > "$USER_BIN/myclaude"
chmod 700 "$USER_BIN/myclaude"
unmanaged_hash="$(sha256sum "$USER_BIN/myclaude" | cut -d' ' -f1)"
if bash "$ROOT/scripts/m365-control.sh" install-myclaude >/dev/null 2>&1; then
  printf '%s\n' 'install-myclaude unexpectedly replaced an unmanaged command' >&2
  exit 1
fi
[[ "$(sha256sum "$USER_BIN/myclaude" | cut -d' ' -f1)" == "$unmanaged_hash" ]]
rm -f "$USER_BIN/myclaude"

bash -n "$ROOT"/*.sh "$ROOT/bin/m365-copilot" "$ROOT/bin/myclaude" "$ROOT/scripts/m365-control.sh"
node --check "$ROOT/scripts/claude-settings.mjs"

printf '%s\n' "launcher smoke tests passed"
