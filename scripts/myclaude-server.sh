#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_DIR="${M365_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/m365-copilot-proxy}"
STATE_DIR="${MYCLAUDE_STATE_ROOT:-${M365_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/m365-copilot-proxy}}"
SOCKET_PATH="${MYCLAUDE_SOCKET:-$STATE_DIR/myclauded.sock}"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_NAME="myclauded.service"
UNIT_FILE="$SYSTEMD_USER_DIR/$UNIT_NAME"
UNIT_MARKER="$UNIT_FILE.managed"
BACKEND_FILE="$STATE_DIR/myclauded.backend"
DAEMON_PID_FILE="$STATE_DIR/myclauded.pid"
PROFILE_CHANGE_FILE="$STATE_DIR/myclaude-profile-change"
ORCHESTRATOR_CLI="$ROOT/packages/orchestrator/dist/cli.mjs"
PRIVATE_NODE_DIR="$ROOT/.runtime/node/node_modules/node/bin"
PRIVATE_TOOL_DIR="$ROOT/.runtime/node/node_modules/.bin"
if [[ -d "$PRIVATE_NODE_DIR" && -d "$PRIVATE_TOOL_DIR" ]]; then
  export PATH="$PRIVATE_TOOL_DIR:$PRIVATE_NODE_DIR:$PATH"
fi
NODE_BIN="$PRIVATE_NODE_DIR/node"
SERVICE_INSTALLER="$ROOT/scripts/myclaude/install-service.mjs"

note() {
  printf '%s\n' "$*"
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

ensure_ready() {
  [[ -x "$NODE_BIN" ]] || die "Private Node.js runtime is unavailable. Run: m365-copilot install"
  [[ -f "$ORCHESTRATOR_CLI" ]] || die "The MyClaude orchestrator is not built. Run: m365-copilot install"
  umask 077
  mkdir -p "$CONFIG_DIR" "$STATE_DIR" "$SYSTEMD_USER_DIR"
  chmod 700 "$CONFIG_DIR" "$STATE_DIR"
  export MYCLAUDE_STATE_ROOT="$STATE_DIR"
  export MYCLAUDE_SOCKET="$SOCKET_PATH"
  export MYCLAUDE_EXECUTOR_BIN="${MYCLAUDE_EXECUTOR_BIN:-$ROOT/bin/myclaude}"
  local hook_settings="${MYCLAUDE_HOOK_SETTINGS:-$CONFIG_DIR/myclaude-hooks.json}"
  if [[ -f "$hook_settings" ]]; then
    export MYCLAUDE_HOOK_SETTINGS="$hook_settings"
    local configured_profile
    configured_profile="$("$NODE_BIN" -e '
      const fs = require("node:fs");
      try {
        const settings = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        process.stdout.write(settings?.env?.MYCLAUDE_EXECUTION_PROFILE ?? "");
      } catch {}
    ' "$hook_settings")"
    case "$configured_profile" in
      guarded|host-unrestricted) export MYCLAUDE_EXECUTION_PROFILE="$configured_profile" ;;
    esac
  fi
  export MYCLAUDE_EXECUTION_PROFILE="${MYCLAUDE_EXECUTION_PROFILE:-guarded}"
}

systemd_user_available() {
  [[ "${MYCLAUDE_FORCE_DETACHED:-0}" != "1" ]] \
    && command -v systemctl >/dev/null 2>&1 \
    && systemctl --user show-environment >/dev/null 2>&1
}

daemon_status() {
  "$NODE_BIN" "$ORCHESTRATOR_CLI" server status
}

daemon_is_running() {
  daemon_status >/dev/null 2>&1
}

write_backend() {
  printf '%s\n' "$1" > "$BACKEND_FILE"
  chmod 600 "$BACKEND_FILE"
}

read_backend() {
  if [[ -f "$BACKEND_FILE" ]]; then
    tr -d '\r\n' < "$BACKEND_FILE"
  fi
}

managed_daemon_pid() {
  [[ -f "$DAEMON_PID_FILE" ]] || return 1
  local pid command_line
  pid="$(tr -dc '0-9' < "$DAEMON_PID_FILE")"
  [[ -n "$pid" && -r "/proc/$pid/cmdline" ]] || return 1
  command_line="$(tr '\0' ' ' < "/proc/$pid/cmdline")"
  [[ "$command_line" == *"$ORCHESTRATOR_CLI server run"* ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  printf '%s' "$pid"
}

stop_managed_daemon_pid() {
  local pid attempt
  pid="$(managed_daemon_pid)" || return 0
  kill -TERM "$pid" 2>/dev/null || return 1
  for attempt in $(seq 1 100); do
    managed_daemon_pid >/dev/null 2>&1 || return 0
    sleep 0.05
  done
  return 1
}

wait_for_daemon() {
  local attempt
  for attempt in $(seq 1 100); do
    if daemon_is_running; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

service_status_json() {
  "$NODE_BIN" "$SERVICE_INSTALLER" status --output "$UNIT_FILE" --socket "$SOCKET_PATH"
}

service_is_intact() {
  [[ -f "$UNIT_MARKER" ]] || return 1
  service_status_json | "$NODE_BIN" -e '
    let body = "";
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => {
      const status = JSON.parse(body);
      process.exit(status.managed && status.intact ? 0 : 1);
    });
  '
}

daemon_busy_count() {
  printf '%s' "$1" | "$NODE_BIN" -e '
    let body = "";
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => {
      const value = JSON.parse(body);
      process.stdout.write(String((value.active?.length ?? 0) + (value.queued?.length ?? 0)));
    });
  '
}

daemon_is_paused_status() {
  printf '%s' "$1" | "$NODE_BIN" -e '
    let body = "";
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => {
      const value = JSON.parse(body);
      process.stdout.write(value.paused === true ? "true" : "false");
    });
  '
}

profile_was_previously_paused() {
  [[ -f "$PROFILE_CHANGE_FILE" ]] && [[ "$(sed -n '2p' "$PROFILE_CHANGE_FILE")" == "true" ]]
}

profile_previous_backend() {
  [[ -f "$PROFILE_CHANGE_FILE" ]] || return 1
  sed -n '3p' "$PROFILE_CHANGE_FILE"
}

write_profile_change() {
  local profile="$1" was_paused="$2" backend="$3"
  local temporary="$PROFILE_CHANGE_FILE.$$.tmp"
  (umask 077; printf '%s\n%s\n%s\n' "$profile" "$was_paused" "$backend" > "$temporary")
  chmod 600 "$temporary"
  mv -f "$temporary" "$PROFILE_CHANGE_FILE"
}

persisted_busy_count() {
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const tasksRoot = path.join(process.argv[1], "tasks");
    const busy = new Set(["queued", "executing", "validating", "repairing"]);
    if (!fs.existsSync(tasksRoot)) {
      process.stdout.write("0");
      process.exit(0);
    }
    let count = 0;
    for (const entry of fs.readdirSync(tasksRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const taskPath = path.join(tasksRoot, entry.name, "task.json");
      try {
        const task = JSON.parse(fs.readFileSync(taskPath, "utf8"));
        if (busy.has(task.state)) count += 1;
      } catch (error) {
        throw new Error(`cannot verify persisted task state at ${taskPath}: ${error.message}`);
      }
    }
    process.stdout.write(String(count));
  ' "$STATE_DIR"
}

managed_daemon_backend() {
  local backend
  backend="$(read_backend)"
  if [[ "$backend" == "systemd" ]]; then
    service_is_intact || return 1
    systemd_user_available || return 1
    systemctl --user is-active --quiet "$UNIT_NAME" || return 1
    printf '%s' systemd
    return 0
  fi
  if [[ "$backend" == "detached" ]]; then
    printf '%s' detached
    return 0
  fi
  return 1
}

install_service() {
  "$NODE_BIN" "$SERVICE_INSTALLER" install \
    --executable "$ROOT/bin/myclaude" \
    --socket "$SOCKET_PATH" \
    --state-root "$STATE_DIR" \
    --config-dir "$CONFIG_DIR" \
    --local-env "${M365_LOCAL_ENV:-$CONFIG_DIR/proxy.env}" \
    --hook-settings "${MYCLAUDE_HOOK_SETTINGS:-$CONFIG_DIR/myclaude-hooks.json}" \
    --executor "${MYCLAUDE_EXECUTOR_BIN:-$ROOT/bin/myclaude}" \
    --executor-args "${MYCLAUDE_EXECUTOR_ARGS:-}" \
    --profile "${MYCLAUDE_EXECUTION_PROFILE:-guarded}" \
    --executor-resume "${MYCLAUDE_EXECUTOR_RESUME:-1}" \
    --concurrency "${MYCLAUDE_CONCURRENCY:-1}" \
    --allowed-workspace-roots "${MYCLAUDE_ALLOWED_WORKSPACE_ROOTS:-}" \
    --bwrap-bin "${MYCLAUDE_BWRAP_BIN:-/usr/bin/bwrap}" \
    --output "$UNIT_FILE" >/dev/null
}

start_daemon() {
  ensure_ready
  if daemon_is_running; then
    managed_daemon_backend >/dev/null 2>&1 \
      || die "A MyClaude daemon is already running, but it is not managed by this launcher. Stop it first."
    daemon_status
    return 0
  fi

  if systemd_user_available; then
    install_service
    systemctl --user daemon-reload
    systemctl --user enable --now "$UNIT_NAME"
    write_backend systemd
    if ! wait_for_daemon; then
      systemctl --user disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
      die "myclauded did not start through systemd. Check: systemctl --user status $UNIT_NAME"
    fi
  else
    "$NODE_BIN" "$ORCHESTRATOR_CLI" server start >/dev/null
    write_backend detached
    wait_for_daemon || die "myclauded detached fallback did not become ready"
  fi
  daemon_status
}

start_daemon_for_backend() {
  local backend="$1"
  case "$backend" in
    detached) (export MYCLAUDE_FORCE_DETACHED=1; start_daemon) ;;
    systemd)
      systemd_user_available || return 1
      start_daemon
      ;;
    *) return 1 ;;
  esac
}

stop_daemon() {
  ensure_ready
  local backend
  backend="$(read_backend)"

  if [[ "$backend" == "systemd" ]] && command -v systemctl >/dev/null 2>&1; then
    if ! systemctl --user disable --now "$UNIT_NAME" >/dev/null 2>&1 && daemon_is_running; then
      "$NODE_BIN" "$ORCHESTRATOR_CLI" server stop >/dev/null
    fi
  elif daemon_is_running; then
    "$NODE_BIN" "$ORCHESTRATOR_CLI" server stop >/dev/null
  fi

  local attempt
  for attempt in $(seq 1 50); do
    daemon_is_running || break
    sleep 0.1
  done
  if daemon_is_running; then
    die "myclauded is still running; inspect $STATE_DIR/myclauded.log"
  fi
  rm -f "$BACKEND_FILE"
  note "MyClaude task orchestrator stopped."
}

restore_recorded_profile_daemon() {
  [[ -f "$PROFILE_CHANGE_FILE" ]] || return 1
  local backend was_paused=false
  backend="$(profile_previous_backend)"
  if [[ "$backend" == "stopped" ]]; then
    daemon_is_running && return 1
    rm -f "$PROFILE_CHANGE_FILE"
    return 0
  fi
  profile_was_previously_paused && was_paused=true
  if ! daemon_is_running; then
    start_daemon_for_backend "$backend" >/dev/null || return 1
  fi
  if [[ "$was_paused" == true ]]; then
    "$NODE_BIN" "$ORCHESTRATOR_CLI" server pause >/dev/null || return 1
  else
    "$NODE_BIN" "$ORCHESTRATOR_CLI" server resume >/dev/null || return 1
  fi
  rm -f "$PROFILE_CHANGE_FILE"
}

status_daemon() {
  ensure_ready
  if ! daemon_is_running; then
    local backend
    backend="$(read_backend)"
    if [[ "$backend" == "systemd" ]] && systemd_user_available; then
      systemctl --user status "$UNIT_NAME" --no-pager >&2 || true
    fi
    die "MyClaude task orchestrator is not running at $SOCKET_PATH"
  fi
  daemon_status
}

restart_daemon() {
  ensure_ready
  local was_running=false
  daemon_is_running && was_running=true
  if [[ "$was_running" == true ]]; then
    stop_daemon >/dev/null
  fi
  start_daemon
}

remove_managed_service() {
  umask 077
  mkdir -p "$CONFIG_DIR" "$STATE_DIR" "$SYSTEMD_USER_DIR"
  chmod 700 "$CONFIG_DIR" "$STATE_DIR"
  local backend stop_failed=false service_intact=false claims_managed=false
  backend="$(read_backend)"

  # Authenticate ownership before addressing the public unit name. A stale
  # marker/backend must never disable a locally repurposed myclauded.service.
  if [[ -x "$NODE_BIN" && -f "$UNIT_MARKER" ]] && service_is_intact; then
    service_intact=true
  fi
  if [[ "$backend" == "systemd" || "$backend" == "detached" ]]; then
    claims_managed=true
  fi

  # Unit-name operations are safe only while the generated unit still matches
  # its digest. A unit may remain installed after an ordinary stop, so this
  # alone does not authenticate a separately launched daemon.
  if [[ "$service_intact" == true ]] && command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
  fi

  if [[ "$claims_managed" == true ]]; then
    # A recorded backend may use a validated PID fallback when systemd is
    # unavailable or the owned unit was locally modified.
    if managed_daemon_pid >/dev/null 2>&1; then
      stop_managed_daemon_pid || stop_failed=true
    fi
    if [[ -x "$NODE_BIN" && -f "$ORCHESTRATOR_CLI" ]] && daemon_is_running; then
      # A process answers at the socket but is not our validated recorded PID.
      # Do not send an unauthenticated shutdown to it.
      stop_failed=true
    fi
    managed_daemon_pid >/dev/null 2>&1 && stop_failed=true
  elif [[ -x "$NODE_BIN" && -f "$ORCHESTRATOR_CLI" ]] && daemon_is_running; then
    die "An unmanaged MyClaude daemon is running; stop it before uninstalling managed files."
  fi
  if [[ "$stop_failed" == true ]]; then
    die "Could not stop the managed MyClaude task orchestrator; service files were preserved."
  fi
  rm -f "$BACKEND_FILE" "$PROFILE_CHANGE_FILE"

  if [[ ! -e "$UNIT_FILE" && ! -e "$UNIT_MARKER" ]]; then
    return 0
  fi
  [[ -x "$NODE_BIN" ]] || {
    note "Preserved the managed service files because the private Node.js runtime is unavailable: $UNIT_FILE" >&2
    return 0
  }
  if [[ "$service_intact" != true ]]; then
    note "Preserved unmanaged or locally modified systemd unit: $UNIT_FILE" >&2
    return 0
  fi
  "$NODE_BIN" "$SERVICE_INSTALLER" remove --output "$UNIT_FILE" --socket "$SOCKET_PATH" >/dev/null
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
}

profile_preflight() {
  ensure_ready
  local profile="${1:-}"
  [[ "$profile" == "guarded" || "$profile" == "host-unrestricted" ]] \
    || die "Profile must be guarded or host-unrestricted."
  [[ ! -f "$PROFILE_CHANGE_FILE" ]] \
    || die "An unfinished profile change exists. Run the managed profile command again after recovery."
  if ! daemon_is_running; then
    write_profile_change "$profile" false stopped
    note "MyClaude task orchestrator is stopped; the profile will apply on its next start."
    return 0
  fi

  local status busy backend was_paused persisted_busy
  status="$(daemon_status)"
  was_paused="$(daemon_is_paused_status "$status")"
  busy="$(daemon_busy_count "$status")"
  if (( busy > 0 )); then
    die "Refusing to change profile while myclauded has $busy active or queued task(s)."
  fi
  backend="$(managed_daemon_backend 2>/dev/null || true)"
  if [[ -z "$backend" ]]; then
    die "Refusing to change profile while an unmanaged myclauded is running. Stop it first."
  fi

  # Pausing closes the check/write race: work submitted after this point may
  # queue, but cannot begin with hook settings that do not match daemon policy.
  "$NODE_BIN" "$ORCHESTRATOR_CLI" server pause >/dev/null
  status="$(daemon_status)"
  busy="$(daemon_busy_count "$status")"
  if (( busy > 0 )); then
    if [[ "$was_paused" != "true" ]]; then
      "$NODE_BIN" "$ORCHESTRATOR_CLI" server resume >/dev/null 2>&1 || true
    fi
    die "Refusing to change profile because $busy task(s) became active or queued during preflight."
  fi

  # Persist recovery metadata before taking the daemon offline. Public
  # lifecycle commands refuse to run while this marker exists.
  write_profile_change "$profile" "$was_paused" "$backend"

  # Take the idle daemon fully offline before the hook file can change. This
  # closes task admission at the Unix socket; a final persisted-state scan
  # catches a task that raced with shutdown and restores the old daemon.
  local stop_output
  if ! stop_output="$(stop_daemon 2>&1)"; then
    if restore_recorded_profile_daemon >/dev/null 2>&1; then
      die "Could not stop myclauded for the profile change; the previous daemon was restored."
    fi
    die "Could not stop myclauded and automatic recovery failed; profile transaction metadata was preserved at $PROFILE_CHANGE_FILE."
  fi
  if ! persisted_busy="$(persisted_busy_count)"; then
    if restore_recorded_profile_daemon >/dev/null 2>&1; then
      die "Could not verify persisted task state; the previous daemon was restored."
    fi
    die "Could not verify persisted task state and automatic recovery failed; profile transaction metadata was preserved at $PROFILE_CHANGE_FILE."
  fi
  if (( persisted_busy > 0 )); then
    if restore_recorded_profile_daemon >/dev/null 2>&1; then
      die "Refusing to change profile because $persisted_busy task(s) raced with daemon shutdown; the previous daemon was restored."
    fi
    die "A task raced with shutdown and automatic recovery failed; profile transaction metadata was preserved at $PROFILE_CHANGE_FILE."
  fi
  note "Stopped the idle managed MyClaude task orchestrator for a profile change."
}

profile_abort() {
  ensure_ready
  [[ -f "$PROFILE_CHANGE_FILE" ]] || return 0
  if daemon_is_running; then
    [[ "$(profile_previous_backend)" != "stopped" ]] \
      || die "An unmanaged daemon appeared during the stopped-daemon profile transaction; stop it before recovery."
    if ! stop_daemon >/dev/null; then
      die "Could not stop the partially applied daemon; profile transaction metadata was preserved."
    fi
  fi
  restore_recorded_profile_daemon >/dev/null \
    || die "Could not restore the previous daemon; profile transaction metadata was preserved at $PROFILE_CHANGE_FILE."
}

profile_quiesce() {
  ensure_ready
  [[ -f "$PROFILE_CHANGE_FILE" ]] || return 0
  if daemon_is_running; then
    [[ "$(profile_previous_backend)" != "stopped" ]] \
      || die "An unmanaged daemon appeared during the stopped-daemon profile transaction; it was not stopped."
    stop_daemon >/dev/null \
      || die "Could not stop the partially applied daemon; profile transaction metadata was preserved."
  fi
}

profile_applied() {
  ensure_ready
  local profile="${1:-}"
  [[ "$profile" == "guarded" || "$profile" == "host-unrestricted" ]] \
    || die "Profile must be guarded or host-unrestricted."
  if [[ ! -f "$PROFILE_CHANGE_FILE" ]]; then
    if daemon_is_running; then
      die "Profile transaction metadata is missing while myclauded is running."
    fi
    return 0
  fi
  if daemon_is_running; then
    die "Refusing to apply a profile while myclauded unexpectedly remains online."
  fi

  local backend was_paused=false transaction_profile
  transaction_profile="$(sed -n '1p' "$PROFILE_CHANGE_FILE")"
  [[ "$transaction_profile" == "$profile" ]] || die "Profile transaction mismatch."
  backend="$(profile_previous_backend)"
  profile_was_previously_paused && was_paused=true
  if [[ "$backend" == "stopped" ]]; then
    rm -f "$PROFILE_CHANGE_FILE"
    note "MyClaude task orchestrator is stopped; profile $profile will apply on its next start."
    return 0
  fi
  start_daemon_for_backend "$backend" >/dev/null
  if [[ "$was_paused" == true ]]; then
    "$NODE_BIN" "$ORCHESTRATOR_CLI" server pause >/dev/null
  fi
  rm -f "$PROFILE_CHANGE_FILE"
  note "Restarted the idle MyClaude task orchestrator with profile $profile."
}

command_name="${1:-status}"
shift || true
case "$command_name" in
  start)
    [[ ! -f "$PROFILE_CHANGE_FILE" ]] || die "A profile change is in progress; retry after it finishes."
    start_daemon "$@"
    ;;
  stop)
    [[ ! -f "$PROFILE_CHANGE_FILE" ]] || die "A profile change is in progress; retry after it finishes."
    stop_daemon "$@"
    ;;
  status) status_daemon "$@" ;;
  restart)
    [[ ! -f "$PROFILE_CHANGE_FILE" ]] || die "A profile change is in progress; retry after it finishes."
    restart_daemon "$@"
    ;;
  remove-service)
    [[ ! -f "$PROFILE_CHANGE_FILE" ]] || die "A profile change is in progress; retry after it finishes."
    remove_managed_service "$@"
    ;;
  profile-preflight) profile_preflight "$@" ;;
  profile-quiesce) profile_quiesce "$@" ;;
  profile-abort) profile_abort "$@" ;;
  profile-applied) profile_applied "$@" ;;
  *) die "Unknown MyClaude server command: $command_name" ;;
esac
