#!/usr/bin/env bash
set -euo pipefail

STATE="${FAKE_SYSTEMCTL_STATE:?FAKE_SYSTEMCTL_STATE is required}"
mkdir -p "$STATE"
if [[ "${1:-}" == "--user" ]]; then shift; fi
command_name="${1:-}"
shift || true
printf '%s\t%s\n' "$command_name" "$*" >> "$STATE/actions.log"

unit_pid_file() {
  printf '%s/%s.pid' "$STATE" "${1//\//_}"
}

unit_is_active() {
  local pid_file pid
  pid_file="$(unit_pid_file "$1")"
  [[ -f "$pid_file" ]] || return 1
  pid="$(tr -dc '0-9' < "$pid_file")"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

start_unit() {
  local unit="$1" unit_file exec_line
  unit_is_active "$unit" && return 0
  unit_file="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$unit"
  [[ -f "$unit_file" ]] || { printf 'missing fake unit: %s\n' "$unit_file" >&2; return 1; }
  exec_line="$(sed -n 's/^ExecStart=//p' "$unit_file" | head -n 1)"
  (
    local assignment key value
    # A real user manager does not inherit variables exported only by the
    # command that later invokes systemctl. Clear the daemon contract first so
    # a missing Environment= line cannot be masked by this test double.
    unset M365_STATE_DIR M365_CONFIG_DIR M365_LOCAL_ENV \
      MYCLAUDE_STATE_ROOT MYCLAUDE_SOCKET MYCLAUDE_HOOK_SETTINGS \
      MYCLAUDE_EXECUTION_PROFILE MYCLAUDE_EXECUTOR_BIN \
      MYCLAUDE_EXECUTOR_ARGS MYCLAUDE_EXECUTOR_RESUME \
      MYCLAUDE_CONCURRENCY MYCLAUDE_ALLOWED_WORKSPACE_ROOTS \
      MYCLAUDE_BWRAP_BIN
    while IFS= read -r assignment; do
      key="${assignment%%=*}"
      value="${assignment#*=}"
      value="${value#\"}"
      value="${value%\"}"
      value="${value//\\\"/\"}"
      value="${value//\\\\/\\}"
      value="${value//%%/%}"
      export "$key=$value"
    done < <(sed -n 's/^Environment=//p' "$unit_file")
    exec_line="${exec_line//%%/%}"
    eval "exec $exec_line"
  ) >> "$STATE/$unit.log" 2>&1 &
  printf '%s\n' "$!" > "$(unit_pid_file "$unit")"
}

stop_unit() {
  local unit="$1" pid_file pid attempt
  pid_file="$(unit_pid_file "$unit")"
  if [[ -f "$pid_file" ]]; then
    pid="$(tr -dc '0-9' < "$pid_file")"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
      for attempt in $(seq 1 50); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.05
      done
      kill -KILL "$pid" 2>/dev/null || true
    fi
    rm -f "$pid_file"
  fi
}

case "$command_name" in
  show-environment)
    [[ "${FAKE_SYSTEMCTL_AVAILABLE:-1}" == "1" ]]
    ;;
  daemon-reload|reset-failed)
    ;;
  enable)
    if [[ "${1:-}" == "--now" ]]; then shift; fi
    start_unit "${1:?unit is required}"
    ;;
  start)
    start_unit "${1:?unit is required}"
    ;;
  disable)
    if [[ "${1:-}" == "--now" ]]; then shift; fi
    stop_unit "${1:?unit is required}"
    ;;
  stop)
    stop_unit "${1:?unit is required}"
    ;;
  is-active)
    if [[ "${1:-}" == "--quiet" ]]; then shift; fi
    unit_is_active "${1:?unit is required}"
    ;;
  show)
    unit="${1:?unit is required}"
    pid_file="$(unit_pid_file "$unit")"
    if [[ "$*" == *MainPID* && -f "$pid_file" ]]; then
      tr -dc '0-9' < "$pid_file"
      printf '\n'
    else
      printf '0\n'
    fi
    ;;
  status)
    unit="${1:?unit is required}"
    if unit_is_active "$unit"; then
      printf '%s active (fake systemctl)\n' "$unit"
    else
      printf '%s inactive (fake systemctl)\n' "$unit" >&2
      exit 3
    fi
    ;;
  *)
    printf 'unsupported fake systemctl command: %s %s\n' "$command_name" "$*" >&2
    exit 2
    ;;
esac
