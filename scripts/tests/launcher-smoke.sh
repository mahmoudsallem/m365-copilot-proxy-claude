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
bash "$ROOT/scripts/m365-control.sh" profile guarded >/dev/null
[[ "$(jq -r '.env.MYCLAUDE_EXECUTION_PROFILE' "$CONFIG_DIR/myclaude-hooks.json")" == "guarded" ]]
[[ "$(jq -r '.model' "$CONFIG_DIR/myclaude-hooks.json")" == "claude-m365--gpt-5.5-think-deeper" ]]
# The repository path contains a space; parsing managed settings must still
# invoke the private Node executable as one correctly quoted path.
"$USER_BIN/myclaude" help | grep -q 'verified M365 executor'
bash "$ROOT/scripts/m365-control.sh" profile host-unrestricted >/dev/null
[[ "$(jq -r '.env.MYCLAUDE_EXECUTION_PROFILE' "$CONFIG_DIR/myclaude-hooks.json")" == "host-unrestricted" ]]

# A modified settings body must never activate the unrestricted Claude Code
# flag. The launcher fails before probing the proxy or invoking Claude.
cp "$CONFIG_DIR/myclaude-hooks.json" "$TEST_ROOT/intact-hooks.json"
printf '%s\n' '# modified' >> "$CONFIG_DIR/myclaude-hooks.json"
if "$USER_BIN/myclaude" -p 'must not run' >"$TEST_ROOT/tampered-hooks.log" 2>&1; then
  printf '%s\n' 'myclaude accepted modified managed hooks' >&2
  exit 1
fi
grep -q 'verified MyClaude hooks failed their ownership/digest check' "$TEST_ROOT/tampered-hooks.log"
mv "$TEST_ROOT/intact-hooks.json" "$CONFIG_DIR/myclaude-hooks.json"

# Catalog output is available as stable JSON or an annotated human table.
printf '%s\n' '#!/usr/bin/env bash' \
  'printf '\''%s\n'\'' '\''{"object":"list","data":[{"id":"gpt-test","x_m365_certification":"verified","x_m365_tone":"Gpt_Quick","max_input_tokens":128000,"max_output_tokens":3072},{"id":"gpt-experimental","x_m365_certification":"experimental","x_m365_tone":"ThinkDeeper","max_input_tokens":128000,"max_output_tokens":3072}]}'\''' \
  > "$FAKE_BIN/curl"
chmod 700 "$FAKE_BIN/curl"
models_json="$("$USER_BIN/myclaude" models --all --json)"
[[ "$(jq -r 'length' <<<"$models_json")" == "2" ]]
[[ "$(jq -r '.[0].x_m365_certification' <<<"$models_json")" == "verified" ]]
models_human="$("$USER_BIN/myclaude" models)"
grep -Fq $'MODEL\tSTATUS\tTONE\tINPUT\tOUTPUT' <<<"$models_human"
grep -Fq $'gpt-test\tverified\tGpt_Quick\t128000\t3072' <<<"$models_human"
if "$USER_BIN/myclaude" models --unsupported >/dev/null 2>&1; then
  printf '%s\n' 'models unexpectedly accepted an unknown option' >&2
  exit 1
fi

# The research command is managed independently and never replaces a collision.
bash "$ROOT/scripts/m365-control.sh" install-research >/dev/null
[[ -L "$USER_BIN/myclaude-research" ]]
[[ "$(readlink "$USER_BIN/myclaude-research")" == "$ROOT/bin/myclaude-research" ]]
"$USER_BIN/myclaude-research" help | grep -q 'myclaude-research search'
bash "$ROOT/scripts/m365-control.sh" remove-research >/dev/null
printf '#!/usr/bin/env bash\nprintf "unmanaged-research\\n"\n' > "$USER_BIN/myclaude-research"
chmod 700 "$USER_BIN/myclaude-research"
research_hash="$(sha256sum "$USER_BIN/myclaude-research" | cut -d' ' -f1)"
if bash "$ROOT/scripts/m365-control.sh" install-research >/dev/null 2>&1; then
  printf '%s\n' 'install-research unexpectedly replaced an unmanaged command' >&2
  exit 1
fi
[[ "$(sha256sum "$USER_BIN/myclaude-research" | cut -d' ' -f1)" == "$research_hash" ]]
rm -f "$USER_BIN/myclaude-research"

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
