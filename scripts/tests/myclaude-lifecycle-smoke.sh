#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NODE_BIN="$ROOT/.runtime/node/node_modules/node/bin/node"
TEST_ROOT="$(mktemp -d /tmp/myclaude-lifecycle.XXXXXX)"
TEST_HOME="$TEST_ROOT/home with spaces"
USER_BIN="$TEST_HOME/.local/bin"
CONFIG_DIR="$TEST_HOME/.config/m365-copilot-proxy"
STATE_DIR="$TEST_HOME/.local/state/m365-copilot-proxy"
FAKE_BIN="$TEST_ROOT/fake-bin"
SYSTEMCTL_STATE="$TEST_ROOT/systemctl"
WORKSPACE="$TEST_ROOT/workspace"

cleanup() {
  if [[ -x "$NODE_BIN" && -f "$ROOT/packages/orchestrator/dist/cli.mjs" ]]; then
    HOME="$TEST_HOME" MYCLAUDE_STATE_ROOT="$STATE_DIR" MYCLAUDE_SOCKET="$STATE_DIR/myclauded.sock" \
      "$NODE_BIN" "$ROOT/packages/orchestrator/dist/cli.mjs" server stop >/dev/null 2>&1 || true
  fi
  if [[ -d "$SYSTEMCTL_STATE" ]]; then
    local pid_file pid
    for pid_file in "$SYSTEMCTL_STATE"/*.pid; do
      [[ -f "$pid_file" ]] || continue
      pid="$(tr -dc '0-9' < "$pid_file")"
      [[ -z "$pid" ]] || kill -TERM "$pid" >/dev/null 2>&1 || true
    done
  fi
  if [[ "${MYCLAUDE_TEST_KEEP_TMP:-0}" == "1" ]]; then
    printf 'Preserved lifecycle test state: %s\n' "$TEST_ROOT" >&2
    return
  fi
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT

[[ -x "$NODE_BIN" ]] || { printf '%s\n' "private Node runtime is missing; run m365-copilot install" >&2; exit 1; }
[[ -f "$ROOT/packages/orchestrator/dist/cli.mjs" ]] || { printf '%s\n' "orchestrator is not built" >&2; exit 1; }

mkdir -p "$USER_BIN" "$FAKE_BIN" "$CONFIG_DIR" "$STATE_DIR" "$WORKSPACE"
ln -s "$ROOT/scripts/tests/fake-systemctl.sh" "$FAKE_BIN/systemctl"
printf '#!/usr/bin/env bash\nprintf "fake-claude:%%s\\n" "$*"\n' > "$FAKE_BIN/claude"
printf '#!/usr/bin/env bash\nexit 22\n' > "$FAKE_BIN/curl"
printf '#!/usr/bin/env bash\nexit 99\n' > "$FAKE_BIN/npm"
ln -s "$NODE_BIN" "$FAKE_BIN/node"
chmod 700 "$FAKE_BIN/claude" "$FAKE_BIN/curl" "$FAKE_BIN/npm"

git -C "$WORKSPACE" init -q
git -C "$WORKSPACE" config user.email test@example.invalid
git -C "$WORKSPACE" config user.name 'MyClaude Test'
printf '%s\n' 'fixture' > "$WORKSPACE/fixture.txt"
printf '%s\n' '{"scripts":{"test":"node -e \"process.exit(0)\""}}' > "$WORKSPACE/package.json"
git -C "$WORKSPACE" add fixture.txt package.json
git -C "$WORKSPACE" commit -qm initial

export HOME="$TEST_HOME"
export XDG_CONFIG_HOME="$TEST_HOME/.config"
export XDG_STATE_HOME="$TEST_HOME/.local/state"
export M365_BIN_DIR="$USER_BIN"
export M365_CONFIG_DIR="$CONFIG_DIR"
export M365_STATE_DIR="$STATE_DIR"
export M365_LOCAL_ENV="$CONFIG_DIR/proxy.env"
export MYCLAUDE_STATE_ROOT="$STATE_DIR"
export MYCLAUDE_SOCKET="$STATE_DIR/myclauded.sock"
export MYCLAUDE_HOOK_SETTINGS="$CONFIG_DIR/myclaude-hooks.json"
export MYCLAUDE_EXECUTOR_BIN="$ROOT/scripts/tests/fake-myclaude-executor.sh"
export MYCLAUDE_EXECUTOR_ARGS='[]'
export MYCLAUDE_EXECUTOR_RESUME=0
export MYCLAUDE_CONCURRENCY=2
export MYCLAUDE_ALLOWED_WORKSPACE_ROOTS="$TEST_ROOT"
export MYCLAUDE_BWRAP_BIN=/usr/bin/bwrap
export MYCLAUDE_TEST_EXECUTOR_DELAY=3
export FAKE_SYSTEMCTL_STATE="$SYSTEMCTL_STATE"
export FAKE_SYSTEMCTL_AVAILABLE=1
export PATH="$USER_BIN:$FAKE_BIN:/usr/bin:/bin"
unset MYCLAUDE_EXECUTION_PROFILE MYCLAUDE_FORCE_DETACHED

# Setup and launch through the managed user-systemd backend.  The optional
# full-install mode also verifies the one-click command without making that
# dependency/build work part of every launcher smoke run.
if [[ "${MYCLAUDE_TEST_FULL_INSTALL:-0}" == "1" ]]; then
  M365_INSTALL_USE_EXISTING_BUILD=1 bash "$ROOT/scripts/m365-control.sh" install >/dev/null
else
  bash "$ROOT/scripts/m365-control.sh" profile guarded >/dev/null
  bash "$ROOT/scripts/m365-control.sh" install-myclaude >/dev/null
  bash "$ROOT/scripts/m365-control.sh" install-research >/dev/null
fi
# The repository path itself contains spaces, exercising every Node executable
# quotation in both the direct launcher and its generated service.
"$USER_BIN/myclaude" help | grep -q 'verified M365 executor'
"$USER_BIN/myclaude-research" help | grep -q 'myclaude-research search'

start_status="$("$USER_BIN/myclaude" server start)"
[[ "$(printf '%s' "$start_status" | jq -r '.executionProfile')" == "guarded" ]]
[[ -S "$MYCLAUDE_SOCKET" ]]
[[ "$(cat "$STATE_DIR/myclauded.backend")" == "systemd" ]]
UNIT="$XDG_CONFIG_HOME/systemd/user/myclauded.service"
[[ -f "$UNIT" && -f "$UNIT.managed" ]]
grep -Fq "Environment=MYCLAUDE_STATE_ROOT=\"$STATE_DIR\"" "$UNIT"
grep -Fq "Environment=M365_CONFIG_DIR=\"$CONFIG_DIR\"" "$UNIT"
grep -Fq "Environment=M365_LOCAL_ENV=\"$CONFIG_DIR/proxy.env\"" "$UNIT"
grep -Fq "Environment=MYCLAUDE_HOOK_SETTINGS=\"$CONFIG_DIR/myclaude-hooks.json\"" "$UNIT"
grep -Fq "Environment=MYCLAUDE_EXECUTOR_BIN=\"$ROOT/scripts/tests/fake-myclaude-executor.sh\"" "$UNIT"
grep -Fq 'Environment=MYCLAUDE_EXECUTOR_ARGS="[]"' "$UNIT"
grep -Fq 'Environment=MYCLAUDE_EXECUTOR_RESUME="0"' "$UNIT"
grep -Fq 'Environment=MYCLAUDE_CONCURRENCY="2"' "$UNIT"
grep -Fq "Environment=MYCLAUDE_ALLOWED_WORKSPACE_ROOTS=\"$TEST_ROOT\"" "$UNIT"
grep -Fq 'Environment=MYCLAUDE_BWRAP_BIN="/usr/bin/bwrap"' "$UNIT"
grep -Fq $'enable\t--now myclauded.service' "$SYSTEMCTL_STATE/actions.log"
first_pid="$(jq -r '.pid' <<<"$start_status")"

# An idle managed daemon restarts immediately with the new hook/policy profile.
bash "$ROOT/scripts/m365-control.sh" profile host-unrestricted >/dev/null
idle_status="$("$USER_BIN/myclaude" server status)"
[[ "$(jq -r '.executionProfile' <<<"$idle_status")" == "host-unrestricted" ]]
second_pid="$(jq -r '.pid' <<<"$idle_status")"
[[ "$second_pid" != "$first_pid" ]]
[[ "$(jq -r '.env.MYCLAUDE_EXECUTION_PROFILE' "$CONFIG_DIR/myclaude-hooks.json")" == "host-unrestricted" ]]

# The settings update and daemon restart are one serialized transaction. A
# concurrent caller fails before changing either side of that contract.
locked_digest="$(sha256sum "$CONFIG_DIR/myclaude-hooks.json" | cut -d' ' -f1)"
exec 9>"$CONFIG_DIR/myclaude-profile.lock"
flock -n 9
if bash "$ROOT/scripts/m365-control.sh" profile guarded >"$TEST_ROOT/locked-profile.log" 2>&1; then
  printf '%s\n' 'profile change unexpectedly bypassed the transaction lock' >&2
  exit 1
fi
grep -q 'profile change is already in progress' "$TEST_ROOT/locked-profile.log"
[[ "$(sha256sum "$CONFIG_DIR/myclaude-hooks.json" | cut -d' ' -f1)" == "$locked_digest" ]]
[[ "$(jq -r '.pid' < <("$USER_BIN/myclaude" server status))" == "$second_pid" ]]
flock -u 9
exec 9>&-

# `myclaude` must prepend its private pnpm/Node tools because a real user
# systemd service starts with a minimal PATH.  This validation would be ENOENT
# without that launcher behavior.
task_log="$TEST_ROOT/task.log"
"$USER_BIN/myclaude" task start --planner none --workspace "$WORKSPACE" \
  --task 'Exercise profile exclusion.' --risk low --validate 'pnpm test' >"$task_log" 2>&1 &
task_pid=$!
busy=false
for _ in $(seq 1 100); do
  daemon_status="$("$USER_BIN/myclaude" server status 2>/dev/null || true)"
  if [[ -n "$daemon_status" ]] && (( $(jq '(.active | length) + (.queued | length)' <<<"$daemon_status") > 0 )); then
    busy=true
    break
  fi
  sleep 0.05
done
[[ "$busy" == true ]] || { printf '%s\n' 'task never became active' >&2; exit 1; }

settings_digest="$(sha256sum "$CONFIG_DIR/myclaude-hooks.json" | cut -d' ' -f1)"
if bash "$ROOT/scripts/m365-control.sh" profile guarded >"$TEST_ROOT/busy-profile.log" 2>&1; then
  printf '%s\n' 'profile change unexpectedly succeeded while a task was active' >&2
  exit 1
fi
grep -Eq 'active or queued task|became active or queued' "$TEST_ROOT/busy-profile.log"
[[ "$(sha256sum "$CONFIG_DIR/myclaude-hooks.json" | cut -d' ' -f1)" == "$settings_digest" ]]
[[ "$(jq -r '.pid' < <("$USER_BIN/myclaude" server status))" == "$second_pid" ]]
wait "$task_pid"
grep -q '"state": "passed"' "$task_log"

# Queued work is equally protected; a manually paused daemon must not have its
# profile changed or be resumed as a side effect of the rejected request.
"$USER_BIN/myclaude" server pause >/dev/null
queued_log="$TEST_ROOT/queued-task.log"
"$USER_BIN/myclaude" task start --planner none --workspace "$WORKSPACE" \
  --task 'Exercise queued profile exclusion.' --risk low --validate 'pnpm test' >"$queued_log" 2>&1 &
queued_pid=$!
queued=false
for _ in $(seq 1 100); do
  daemon_status="$("$USER_BIN/myclaude" server status 2>/dev/null || true)"
  if [[ -n "$daemon_status" ]] && (( $(jq '.queued | length' <<<"$daemon_status") > 0 )); then
    queued=true
    break
  fi
  sleep 0.05
done
[[ "$queued" == true ]] || { printf '%s\n' 'task never became queued' >&2; exit 1; }
queued_digest="$(sha256sum "$CONFIG_DIR/myclaude-hooks.json" | cut -d' ' -f1)"
if bash "$ROOT/scripts/m365-control.sh" profile guarded >"$TEST_ROOT/queued-profile.log" 2>&1; then
  printf '%s\n' 'profile change unexpectedly succeeded while a task was queued' >&2
  exit 1
fi
grep -q 'active or queued task' "$TEST_ROOT/queued-profile.log"
[[ "$(sha256sum "$CONFIG_DIR/myclaude-hooks.json" | cut -d' ' -f1)" == "$queued_digest" ]]
[[ "$(jq -r '.paused' < <("$USER_BIN/myclaude" server status))" == "true" ]]
"$USER_BIN/myclaude" server resume >/dev/null
wait "$queued_pid"
grep -q '"state": "passed"' "$queued_log"

# Once idle, the same profile update is allowed and restarts the managed unit
# without losing an intentional operator pause.
"$USER_BIN/myclaude" server pause >/dev/null
bash "$ROOT/scripts/m365-control.sh" profile guarded >/dev/null
guarded_status="$("$USER_BIN/myclaude" server status)"
[[ "$(jq -r '.executionProfile' <<<"$guarded_status")" == "guarded" ]]
[[ "$(jq -r '.paused' <<<"$guarded_status")" == "true" ]]
[[ "$(jq -r '.pid' <<<"$guarded_status")" != "$second_pid" ]]
"$USER_BIN/myclaude" server resume >/dev/null

# A daemon started outside this manager is never restarted behind the user's
# back, and profile settings stay byte-for-byte unchanged.
"$USER_BIN/myclaude" server stop >/dev/null
bash "$ROOT/scripts/myclaude-server.sh" profile-preflight guarded >/dev/null
[[ -f "$STATE_DIR/myclaude-profile-change" ]]
if "$USER_BIN/myclaude" server start >"$TEST_ROOT/profile-start-race.log" 2>&1; then
  printf '%s\n' 'server start unexpectedly bypassed an in-progress stopped-daemon profile change' >&2
  exit 1
fi
grep -q 'profile change is in progress' "$TEST_ROOT/profile-start-race.log"
bash "$ROOT/scripts/myclaude-server.sh" profile-abort >/dev/null
[[ ! -e "$STATE_DIR/myclaude-profile-change" ]]
"$NODE_BIN" "$ROOT/packages/orchestrator/dist/cli.mjs" server start >/dev/null
unmanaged_digest="$(sha256sum "$CONFIG_DIR/myclaude-hooks.json" | cut -d' ' -f1)"
if bash "$ROOT/scripts/m365-control.sh" profile host-unrestricted >"$TEST_ROOT/unmanaged-profile.log" 2>&1; then
  printf '%s\n' 'profile change unexpectedly restarted an unmanaged daemon' >&2
  exit 1
fi
grep -q 'unmanaged myclauded' "$TEST_ROOT/unmanaged-profile.log"
[[ "$(sha256sum "$CONFIG_DIR/myclaude-hooks.json" | cut -d' ' -f1)" == "$unmanaged_digest" ]]
if bash "$ROOT/scripts/m365-control.sh" uninstall >"$TEST_ROOT/unmanaged-uninstall.log" 2>&1; then
  printf '%s\n' 'uninstall unexpectedly stopped or ignored an unmanaged daemon' >&2
  exit 1
fi
grep -q 'unmanaged MyClaude daemon' "$TEST_ROOT/unmanaged-uninstall.log"
[[ -L "$USER_BIN/myclaude" && -L "$USER_BIN/myclaude-research" ]]
[[ "$(sha256sum "$CONFIG_DIR/myclaude-hooks.json" | cut -d' ' -f1)" == "$unmanaged_digest" ]]
"$NODE_BIN" "$ROOT/packages/orchestrator/dist/cli.mjs" server stop >/dev/null

# Explicit start retains a detached fallback when user systemd is unavailable.
export MYCLAUDE_FORCE_DETACHED=1
"$USER_BIN/myclaude" server start >/dev/null
[[ "$(cat "$STATE_DIR/myclauded.backend")" == "detached" ]]
"$USER_BIN/myclaude" server status | jq -e '.pid > 0' >/dev/null
bash "$ROOT/scripts/m365-control.sh" profile host-unrestricted >/dev/null
[[ "$("$USER_BIN/myclaude" server status | jq -r '.executionProfile')" == "host-unrestricted" ]]
bash "$ROOT/scripts/m365-control.sh" profile guarded >/dev/null
[[ "$("$USER_BIN/myclaude" server status | jq -r '.executionProfile')" == "guarded" ]]
"$USER_BIN/myclaude" server stop >/dev/null
unset MYCLAUDE_FORCE_DETACHED

# Intact managed artifacts are stopped and removed on uninstall.  Direct
# Claude is never replaced or deleted.
"$USER_BIN/myclaude" server start >/dev/null
bash "$ROOT/scripts/m365-control.sh" uninstall >/dev/null
[[ ! -e "$USER_BIN/myclaude" && ! -e "$USER_BIN/myclaude-research" ]]
[[ ! -e "$UNIT" && ! -e "$UNIT.managed" ]]
[[ ! -e "$CONFIG_DIR/myclaude-hooks.json" && ! -e "$CONFIG_DIR/myclaude-hooks.json.managed" ]]
[[ "$(claude --version)" == "fake-claude:--version" ]]

# Locally modified managed artifacts are stopped but preserved for recovery.
bash "$ROOT/scripts/m365-control.sh" profile guarded >/dev/null
bash "$ROOT/scripts/m365-control.sh" install-myclaude >/dev/null
bash "$ROOT/scripts/m365-control.sh" install-research >/dev/null
"$USER_BIN/myclaude" server start >/dev/null
printf '%s\n' '# local modification' >> "$UNIT"
printf '%s\n' '# local modification' >> "$CONFIG_DIR/myclaude-hooks.json"
disable_count_before="$(grep -c $'^disable\t--now myclauded.service$' "$SYSTEMCTL_STATE/actions.log" || true)"
bash "$ROOT/scripts/m365-control.sh" remove-research >/dev/null
printf '#!/usr/bin/env bash\nprintf "unmanaged-research\\n"\n' > "$USER_BIN/myclaude-research"
chmod 700 "$USER_BIN/myclaude-research"
unmanaged_research_digest="$(sha256sum "$USER_BIN/myclaude-research" | cut -d' ' -f1)"
bash "$ROOT/scripts/m365-control.sh" uninstall >"$TEST_ROOT/modified-uninstall.log" 2>&1
disable_count_after="$(grep -c $'^disable\t--now myclauded.service$' "$SYSTEMCTL_STATE/actions.log" || true)"
[[ "$disable_count_after" == "$disable_count_before" ]]
[[ -f "$UNIT" && -f "$UNIT.managed" ]]
grep -q 'Preserved unmanaged or locally modified systemd unit' "$TEST_ROOT/modified-uninstall.log"
[[ -f "$CONFIG_DIR/myclaude-hooks.json" && -f "$CONFIG_DIR/myclaude-hooks.json.managed" ]]
grep -q 'Preserved unmanaged or locally modified hook settings' "$TEST_ROOT/modified-uninstall.log"
if "$FAKE_BIN/systemctl" --user is-active --quiet myclauded.service; then
  printf '%s\n' 'modified managed unit was preserved but left running' >&2
  exit 1
fi
[[ ! -e "$USER_BIN/myclaude" ]]
[[ "$(sha256sum "$USER_BIN/myclaude-research" | cut -d' ' -f1)" == "$unmanaged_research_digest" ]]
[[ "$(claude)" == "fake-claude:" ]]

printf '%s\n' 'myclaude lifecycle smoke tests passed'
