#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_DIR="${M365_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/m365-copilot-proxy}"
STATE_DIR="${M365_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/m365-copilot-proxy}"
USER_BIN_DIR="${M365_BIN_DIR:-$HOME/.local/bin}"
ENV_FILE="${M365_LOCAL_ENV:-$CONFIG_DIR/proxy.env}"
PID_FILE="$STATE_DIR/proxy.pid"
LOG_FILE="$STATE_DIR/proxy.log"
CONNECTION_FILE="$STATE_DIR/claude-connection.env"
BACKEND_FILE="$STATE_DIR/proxy.backend"
CLAUDE_WRAPPER="$USER_BIN_DIR/claude"
CLAUDE_DIRECT_WRAPPER="$USER_BIN_DIR/claude-direct"
MYCLAUDE_WRAPPER="$USER_BIN_DIR/myclaude"
MYCLAUDE_RESEARCH_WRAPPER="$USER_BIN_DIR/myclaude-research"
CONTROL_BIN="$ROOT/bin/m365-copilot"
MYCLAUDE_BIN="$ROOT/bin/myclaude"
MYCLAUDE_RESEARCH_BIN="$ROOT/bin/myclaude-research"
MYCLAUDE_HOOK_SETTINGS="$CONFIG_DIR/myclaude-hooks.json"
MYCLAUDE_SERVER_MANAGER="$ROOT/scripts/myclaude-server.sh"
MYCLAUDE_PROFILE_LOCK="$CONFIG_DIR/myclaude-profile.lock"
PROXY_PORT="${PORT:-4141}"
PROXY_URL="http://127.0.0.1:$PROXY_PORT"
SYSTEMD_UNIT_NAME="m365-copilot-proxy.service"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SYSTEMD_UNIT_FILE="$SYSTEMD_USER_DIR/$SYSTEMD_UNIT_NAME"

usage() {
  cat <<'EOF'
M365 Copilot Proxy manager (Linux)

Usage: m365-copilot <command> [options]

Setup:
  install             Install the private Node runtime, dependencies, and command
  login               Sign in in a visible Microsoft browser window
  login-device        Sign in with Microsoft's device-code flow
  doctor              Check installation, authentication, proxy, and Claude status

Proxy:
  start               Start the localhost proxy in the background
  stop                Stop the managed background proxy
  restart             Restart the managed proxy
  status              Show proxy and Claude connection status
  logs [--follow]     Show the proxy log
  models [--all] [--json]
                       List the proxy's M365 model catalog

Claude Code:
  install-myclaude    Install `myclaude` while leaving `claude` direct
  remove-myclaude     Remove only the managed `myclaude` launcher
  install-research    Install the grounded `myclaude-research` command
  remove-research     Remove only the managed research launcher
  profile <name>      Set guarded or host-unrestricted execution hooks
  myclaude [args...]  Start Claude Code through the localhost proxy
  connect-claude      Legacy migration: restore `claude`, install `myclaude`
  disconnect-claude   Restore a legacy managed `claude` wrapper
  claude [args...]    Legacy connected-Claude launcher
  claude-direct [...] Internal original-Claude launcher

Removal:
  uninstall [--purge] Remove launchers; --purge also removes proxy config/logs

No command asks for or stores a Microsoft password or MFA seed.
EOF
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

note() {
  printf '%s\n' "$*"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

ensure_private_dirs() {
  umask 077
  mkdir -p "$CONFIG_DIR" "$STATE_DIR" "$USER_BIN_DIR"
  chmod 700 "$CONFIG_DIR" "$STATE_DIR"
}

ensure_runtime() {
  bash "$ROOT/scripts/setup-local.sh" >/dev/null
}

load_proxy_env() {
  [[ -f "$ENV_FILE" ]] || die "Proxy configuration is missing. Run: m365-copilot install"
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  PROXY_PORT="${PORT:-4141}"
  PROXY_URL="http://127.0.0.1:$PROXY_PORT"
}

proxy_health() {
  [[ -f "$ENV_FILE" ]] || return 1
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  local check_port="${PORT:-4141}"
  curl -fsS --max-time 3 \
    -H "Authorization: Bearer ${M365_PROXY_API_KEY:-}" \
    "http://127.0.0.1:${check_port}/v1/models" >/dev/null 2>&1
}

managed_pid() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(tr -dc '0-9' < "$PID_FILE")"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  printf '%s' "$pid"
}

validate_managed_pid() {
  local pid="$1"
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  tr '\0' ' ' < "/proc/$pid/cmdline" | grep -Fq 'm365-proxy.mjs'
}

systemd_user_available() {
  [[ "${MYCLAUDE_FORCE_DETACHED:-0}" != "1" ]] \
    && command -v systemctl >/dev/null 2>&1 \
    && systemctl --user show-environment >/dev/null 2>&1
}

unit_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//%/%%}"
  printf '"%s"' "$value"
}

install_systemd_unit() {
  mkdir -p "$SYSTEMD_USER_DIR"
  local quoted_script quoted_port quoted_env
  quoted_script="$(unit_quote "$ROOT/scripts/run-proxy-local.sh")"
  quoted_port="$(unit_quote "PORT=$PROXY_PORT")"
  quoted_env="$(unit_quote "M365_LOCAL_ENV=$ENV_FILE")"
  {
    printf '%s\n' '[Unit]'
    printf '%s\n' 'Description=Local Microsoft 365 Copilot compatibility proxy'
    printf '%s\n' 'After=network-online.target'
    printf '%s\n' 'Wants=network-online.target'
    printf '\n%s\n' '[Service]'
    printf 'Environment=%s\n' "$quoted_port"
    printf 'Environment=%s\n' "$quoted_env"
    printf 'ExecStart=/usr/bin/env bash %s\n' "$quoted_script"
    printf '%s\n' 'Restart=on-failure'
    printf '%s\n' 'RestartSec=3'
    printf '%s\n' 'KillMode=control-group'
    printf 'StandardOutput=append:%s\n' "$LOG_FILE"
    printf 'StandardError=append:%s\n' "$LOG_FILE"
    printf '\n%s\n' '[Install]'
    printf '%s\n' 'WantedBy=default.target'
  } > "$SYSTEMD_UNIT_FILE"
  chmod 600 "$SYSTEMD_UNIT_FILE"
  systemctl --user daemon-reload
}

install_all() {
  [[ "$(uname -s)" == "Linux" ]] || die "The one-click launcher currently supports Linux only."
  require_command npm
  require_command curl
  ensure_private_dirs

  note "[1/6] Preparing the private Node.js runtime..."
  bash "$ROOT/scripts/setup-local.sh"
  if [[ "${M365_INSTALL_USE_EXISTING_BUILD:-0}" == "1" ]]; then
    note "[2/6] Using the existing locked dependency installation (test/developer mode)."
    [[ -d "$ROOT/node_modules" ]] || die "Existing dependencies are unavailable. Run install without M365_INSTALL_USE_EXISTING_BUILD."
    note "[3/6] Using the existing package build (test/developer mode)."
    [[ -f "$ROOT/packages/orchestrator/dist/cli.mjs" ]] \
      || die "Existing MyClaude build is unavailable. Run install without M365_INSTALL_USE_EXISTING_BUILD."
  else
    note "[2/6] Installing locked dependencies..."
    bash "$ROOT/scripts/local.sh" install --frozen-lockfile
    note "[3/6] Building all packages..."
    bash "$ROOT/scripts/local.sh" build
  fi
  note "[4/6] Installing verified-execution hooks..."
  local hook_settings="$CONFIG_DIR/myclaude-hooks.json"
  local hook_profile=guarded
  if [[ -f "$hook_settings.managed" ]]; then
    hook_profile="$("$ROOT/.runtime/node/node_modules/node/bin/node" -e '
      const fs = require("node:fs");
      try {
        const marker = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        if (["guarded", "host-unrestricted"].includes(marker.profile)) process.stdout.write(marker.profile);
      } catch {}
    ' "$hook_settings.managed")"
    [[ -n "$hook_profile" ]] || hook_profile=guarded
  fi
  set_myclaude_profile "$hook_profile" >/dev/null
  if [[ "$hook_profile" == "host-unrestricted" ]]; then
    note "Warning: preserving host-unrestricted hooks; they can access every file and credential available to your Unix user."
  fi
  note "[5/6] Installing the m365-copilot, myclaude, and research commands..."
  ln -sfn "$CONTROL_BIN" "$USER_BIN_DIR/m365-copilot"
  install_myclaude true
  install_myclaude_research true
  note "[6/6] Preparing the MyClaude task orchestrator..."
  if systemd_user_available; then
    bash "$MYCLAUDE_SERVER_MANAGER" start >/dev/null
    note "MyClaude task orchestrator installed, enabled, and started with user systemd."
  else
    note "User systemd is unavailable; run 'myclaude server start' for the detached fallback when needed."
  fi

  note ""
  note "Installation complete."
  note "Next: $USER_BIN_DIR/m365-copilot login"
  note "After login: $USER_BIN_DIR/myclaude"
  if [[ ":$PATH:" != *":$USER_BIN_DIR:"* ]]; then
    note "Add this directory to PATH before using the short command: $USER_BIN_DIR"
  fi
}

login_interactive() {
  ensure_runtime
  exec bash "$ROOT/scripts/local.sh" auth
}

login_device() {
  ensure_runtime
  exec bash "$ROOT/scripts/local.sh" auth:device
}

start_proxy() {
  require_command curl
  ensure_private_dirs
  ensure_runtime
  load_proxy_env

  if proxy_health; then
    note "Proxy is already answering at $PROXY_URL"
    return 0
  fi

  local old_pid
  if old_pid="$(managed_pid 2>/dev/null)"; then
    if validate_managed_pid "$old_pid"; then
      die "Proxy process $old_pid exists but is not healthy. Run: m365-copilot stop"
    fi
    rm -f "$PID_FILE"
  fi

  : > "$LOG_FILE"
  chmod 600 "$LOG_FILE"
  local new_pid
  if systemd_user_available; then
    install_systemd_unit
    systemctl --user reset-failed "$SYSTEMD_UNIT_NAME" 2>/dev/null || true
    systemctl --user start "$SYSTEMD_UNIT_NAME"
    printf '%s\n' systemd > "$BACKEND_FILE"
    new_pid="$(systemctl --user show "$SYSTEMD_UNIT_NAME" -p MainPID --value)"
  else
    setsid -f env PORT="$PROXY_PORT" M365_LOCAL_ENV="$ENV_FILE" \
      bash "$ROOT/scripts/run-proxy-local.sh" >>"$LOG_FILE" 2>&1 </dev/null
    new_pid=""
    for attempt in $(seq 1 20); do
      new_pid="$(pgrep -n -f "$ROOT/packages/proxy/bin/m365-proxy.mjs" || true)"
      [[ -n "$new_pid" ]] && break
      sleep 0.1
    done
    printf '%s\n' pid > "$BACKEND_FILE"
  fi
  [[ "$new_pid" =~ ^[0-9]+$ ]] && (( new_pid > 0 )) || die "Proxy service did not return a valid PID."
  printf '%s\n' "$new_pid" > "$PID_FILE"
  chmod 600 "$PID_FILE" "$BACKEND_FILE"

  local attempt
  for attempt in $(seq 1 60); do
    if proxy_health; then
      note "Proxy started in the background at $PROXY_URL (PID $new_pid)"
      note "Log: $LOG_FILE"
      return 0
    fi
    if ! kill -0 "$new_pid" 2>/dev/null; then
      break
    fi
    sleep 0.25
  done

  if [[ "$(cat "$BACKEND_FILE" 2>/dev/null || true)" == "systemd" ]]; then
    systemctl --user stop "$SYSTEMD_UNIT_NAME" 2>/dev/null || true
  else
    kill -TERM "$new_pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE" "$BACKEND_FILE"
  note "Proxy failed to start. Last log lines:" >&2
  tail -n 30 "$LOG_FILE" >&2 || true
  return 1
}

stop_proxy() {
  local pid
  if [[ "$(cat "$BACKEND_FILE" 2>/dev/null || true)" == "systemd" ]] && systemd_user_available; then
    if systemctl --user is-active --quiet "$SYSTEMD_UNIT_NAME"; then
      systemctl --user stop "$SYSTEMD_UNIT_NAME"
      rm -f "$PID_FILE" "$BACKEND_FILE"
      note "Proxy stopped."
      return 0
    fi
    rm -f "$PID_FILE" "$BACKEND_FILE"
  fi
  if ! pid="$(managed_pid 2>/dev/null)"; then
    rm -f "$PID_FILE"
    if proxy_health; then
      printf '%s\n' "Error: A proxy is answering, but it was not started by this manager. Stop its terminal/process manually." >&2
      return 1
    fi
    note "Proxy is not running."
    return 0
  fi

  validate_managed_pid "$pid" || die "Refusing to stop PID $pid because it is not the managed proxy process."
  kill -TERM "$pid"
  local attempt
  for attempt in $(seq 1 50); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      note "Proxy stopped."
      return 0
    fi
    sleep 0.1
  done
  kill -KILL "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  note "Proxy stopped after a forced shutdown."
}

restart_proxy() {
  stop_proxy
  start_proxy
}

claude_is_connected() {
  [[ -f "$CLAUDE_WRAPPER" ]] && grep -q '^# M365_COPILOT_MANAGED_CLAUDE=1$' "$CLAUDE_WRAPPER"
}

status_all() {
  load_proxy_env
  local pid=""
  if [[ "$(cat "$BACKEND_FILE" 2>/dev/null || true)" == "systemd" ]] && systemd_user_available; then
    pid="$(systemctl --user show "$SYSTEMD_UNIT_NAME" -p MainPID --value 2>/dev/null || true)"
    [[ "$pid" == "0" ]] && pid=""
  else
    pid="$(managed_pid 2>/dev/null || true)"
  fi
  if proxy_health; then
    note "Proxy: running at $PROXY_URL${pid:+ (PID $pid)}"
  else
    note "Proxy: stopped or unhealthy at $PROXY_URL"
  fi
  if claude_is_connected; then
    note "Claude: legacy managed wrapper detected (run connect-claude to migrate)"
  else
    note "Claude: normal/direct mode"
  fi
  if [[ -L "$MYCLAUDE_WRAPPER" ]] && [[ "$(readlink "$MYCLAUDE_WRAPPER")" == "$MYCLAUDE_BIN" ]]; then
    note "MyClaude: installed at $MYCLAUDE_WRAPPER"
  else
    note "MyClaude: not installed"
  fi
  if [[ -L "$MYCLAUDE_RESEARCH_WRAPPER" ]] && [[ "$(readlink "$MYCLAUDE_RESEARCH_WRAPPER")" == "$MYCLAUDE_RESEARCH_BIN" ]]; then
    note "MyClaude research: installed at $MYCLAUDE_RESEARCH_WRAPPER"
  else
    note "MyClaude research: not installed"
  fi
  note "Config: $ENV_FILE"
  note "Log: $LOG_FILE"
}

show_logs() {
  [[ -f "$LOG_FILE" ]] || die "No proxy log exists yet."
  if [[ "${1:-}" == "--follow" || "${1:-}" == "-f" ]]; then
    exec tail -f "$LOG_FILE"
  fi
  tail -n 100 "$LOG_FILE"
}

list_models() {
  require_command curl
  load_proxy_env
  proxy_health || die "Proxy is not running. Run: m365-copilot start"
  local json=false argument output_mode=human
  for argument in "$@"; do
    case "$argument" in
      --json) json=true ;;
      --all) ;;
      *) die "Unknown models option: $argument" ;;
    esac
  done
  [[ "$json" == true ]] && output_mode=json
  local node_bin="$ROOT/.runtime/node/node_modules/node/bin/node"
  [[ -x "$node_bin" ]] || node_bin="$(command -v node 2>/dev/null || true)"
  [[ -n "$node_bin" ]] || die "Node.js is unavailable. Run: m365-copilot install"
  curl -fsS -H "Authorization: Bearer ${M365_PROXY_API_KEY}" "$PROXY_URL/v1/models" \
    | "$node_bin" -e '
      let source = "";
      process.stdin.on("data", (chunk) => { source += chunk; });
      process.stdin.on("end", () => {
        const models = JSON.parse(source).data ?? [];
        if (process.argv[1] === "json") {
          process.stdout.write(`${JSON.stringify(models, null, 2)}\n`);
          return;
        }
        process.stdout.write("MODEL\tSTATUS\tTONE\tINPUT\tOUTPUT\n");
        for (const model of models) {
          process.stdout.write([
            model.id,
            model.x_m365_certification ?? "unknown",
            model.x_m365_tone ?? "unknown",
            model.max_input_tokens ?? model.context_window ?? "unknown",
            model.max_output_tokens ?? "unknown",
          ].join("\t") + "\n");
        }
      });
    ' "$output_mode"
}

install_myclaude() {
  local quiet="${1:-false}"
  ensure_private_dirs
  [[ -x "$MYCLAUDE_BIN" ]] || die "MyClaude launcher is not executable: $MYCLAUDE_BIN"

  if [[ -L "$MYCLAUDE_WRAPPER" ]] && [[ "$(readlink "$MYCLAUDE_WRAPPER")" == "$MYCLAUDE_BIN" ]]; then
    [[ "$quiet" == true ]] || note "myclaude is already installed. The ordinary claude command is unchanged."
    return 0
  fi

  if [[ -e "$MYCLAUDE_WRAPPER" || -L "$MYCLAUDE_WRAPPER" ]]; then
    if [[ -f "$MYCLAUDE_WRAPPER" ]] && grep -Eq 'claude-local\.sh|M365_COPILOT_MANAGED_MYCLAUDE=1' "$MYCLAUDE_WRAPPER"; then
      local migrated="$STATE_DIR/myclaude.legacy.$(date +%s)"
      mv "$MYCLAUDE_WRAPPER" "$migrated"
      chmod 600 "$migrated"
      [[ "$quiet" == true ]] || note "Saved the previous local MyClaude wrapper at $migrated"
    else
      die "Refusing to replace an unmanaged command: $MYCLAUDE_WRAPPER"
    fi
  fi

  ln -s "$MYCLAUDE_BIN" "$MYCLAUDE_WRAPPER"
  [[ "$quiet" == true ]] || note "Installed myclaude. The ordinary claude command remains direct Anthropic Claude."
}

remove_myclaude() {
  local preserve_unmanaged="${1:-false}"
  if [[ -L "$MYCLAUDE_WRAPPER" ]] && [[ "$(readlink "$MYCLAUDE_WRAPPER")" == "$MYCLAUDE_BIN" ]]; then
    rm -f "$MYCLAUDE_WRAPPER"
    note "Removed the managed myclaude launcher. The ordinary claude command was not changed."
    return 0
  fi
  if [[ -e "$MYCLAUDE_WRAPPER" || -L "$MYCLAUDE_WRAPPER" ]]; then
    if [[ "$preserve_unmanaged" == true ]]; then
      note "Preserved unmanaged command: $MYCLAUDE_WRAPPER" >&2
      return 0
    fi
    die "Refusing to remove an unmanaged command: $MYCLAUDE_WRAPPER"
  fi
  note "myclaude is not installed."
}

install_myclaude_research() {
  local quiet="${1:-false}"
  ensure_private_dirs
  [[ -x "$MYCLAUDE_RESEARCH_BIN" ]] || die "Research launcher is not executable: $MYCLAUDE_RESEARCH_BIN"
  if [[ -L "$MYCLAUDE_RESEARCH_WRAPPER" ]] && [[ "$(readlink "$MYCLAUDE_RESEARCH_WRAPPER")" == "$MYCLAUDE_RESEARCH_BIN" ]]; then
    [[ "$quiet" == true ]] || note "myclaude-research is already installed."
    return 0
  fi
  if [[ -e "$MYCLAUDE_RESEARCH_WRAPPER" || -L "$MYCLAUDE_RESEARCH_WRAPPER" ]]; then
    die "Refusing to replace an unmanaged command: $MYCLAUDE_RESEARCH_WRAPPER"
  fi
  ln -s "$MYCLAUDE_RESEARCH_BIN" "$MYCLAUDE_RESEARCH_WRAPPER"
  [[ "$quiet" == true ]] || note "Installed myclaude-research at $MYCLAUDE_RESEARCH_WRAPPER"
}

remove_myclaude_research() {
  local preserve_unmanaged="${1:-false}"
  if [[ -L "$MYCLAUDE_RESEARCH_WRAPPER" ]] && [[ "$(readlink "$MYCLAUDE_RESEARCH_WRAPPER")" == "$MYCLAUDE_RESEARCH_BIN" ]]; then
    rm -f "$MYCLAUDE_RESEARCH_WRAPPER"
    note "Removed the managed myclaude-research launcher."
    return 0
  fi
  if [[ -e "$MYCLAUDE_RESEARCH_WRAPPER" || -L "$MYCLAUDE_RESEARCH_WRAPPER" ]]; then
    if [[ "$preserve_unmanaged" == true ]]; then
      note "Preserved unmanaged command: $MYCLAUDE_RESEARCH_WRAPPER" >&2
      return 0
    fi
    die "Refusing to remove an unmanaged command: $MYCLAUDE_RESEARCH_WRAPPER"
  fi
  note "myclaude-research is not installed."
}

remove_managed_hook_settings() {
  local node_bin="$ROOT/.runtime/node/node_modules/node/bin/node"
  [[ -x "$node_bin" ]] || {
    note "Preserved hook settings because the private Node.js runtime is unavailable: $MYCLAUDE_HOOK_SETTINGS" >&2
    return 0
  }
  if [[ ! -e "$MYCLAUDE_HOOK_SETTINGS" && ! -e "$MYCLAUDE_HOOK_SETTINGS.managed" ]]; then
    return 0
  fi
  if ! "$node_bin" "$ROOT/scripts/myclaude/install-hooks.mjs" status --output "$MYCLAUDE_HOOK_SETTINGS" \
      | "$node_bin" -e '
        let body = "";
        process.stdin.on("data", (chunk) => { body += chunk; });
        process.stdin.on("end", () => {
          const status = JSON.parse(body);
          process.exit(status.managed && status.intact ? 0 : 1);
        });
      '; then
    note "Preserved unmanaged or locally modified hook settings: $MYCLAUDE_HOOK_SETTINGS" >&2
    return 0
  fi
  "$node_bin" "$ROOT/scripts/myclaude/install-hooks.mjs" remove --output "$MYCLAUDE_HOOK_SETTINGS" >/dev/null
}

set_myclaude_profile() {
  local profile="${1:-}"
  case "$profile" in
    guarded|host-unrestricted) ;;
    *) die "Profile must be guarded or host-unrestricted." ;;
  esac
  ensure_private_dirs
  ensure_runtime
  require_command flock
  [[ -x "$MYCLAUDE_SERVER_MANAGER" ]] || die "MyClaude server manager is unavailable: $MYCLAUDE_SERVER_MANAGER"
  local node_bin="$ROOT/.runtime/node/node_modules/node/bin/node"
  local profile_lock_fd
  exec {profile_lock_fd}>"$MYCLAUDE_PROFILE_LOCK"
  chmod 600 "$MYCLAUDE_PROFILE_LOCK"
  if ! flock -n "$profile_lock_fd"; then
    exec {profile_lock_fd}>&-
    die "Another MyClaude profile change is already in progress."
  fi
  local previous_status previous_profile previous_kind previous_was_managed=false
  previous_status="$("$node_bin" "$ROOT/scripts/myclaude/install-hooks.mjs" \
    status --output "$MYCLAUDE_HOOK_SETTINGS")"
  previous_kind="$(printf '%s' "$previous_status" | "$node_bin" -e '
    let body = "";
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => {
      const value = JSON.parse(body);
      if (value.installed && value.managed && value.intact && ["guarded", "host-unrestricted"].includes(value.profile)) {
        process.stdout.write(`managed:${value.profile}`);
      } else if (!value.installed && !value.managed) {
        process.stdout.write("absent");
      } else {
        process.stdout.write("unsafe");
      }
    });
  ')"
  case "$previous_kind" in
    managed:*)
      previous_profile="${previous_kind#managed:}"
      previous_was_managed=true
      ;;
    absent) previous_profile="" ;;
    *)
      flock -u "$profile_lock_fd" || true
      exec {profile_lock_fd}>&-
      die "Refusing to change unmanaged, modified, or incomplete hook settings: $MYCLAUDE_HOOK_SETTINGS"
      ;;
  esac

  # This must happen before the hook file is written.  It pauses an idle
  # managed daemon and rejects active, queued, or unmanaged daemons.
  local preflight_output
  if ! preflight_output="$(bash "$MYCLAUDE_SERVER_MANAGER" profile-preflight "$profile" 2>&1)"; then
    flock -u "$profile_lock_fd" || true
    exec {profile_lock_fd}>&-
    printf '%s\n' "$preflight_output" >&2
    return 1
  fi
  [[ -z "$preflight_output" ]] || printf '%s\n' "$preflight_output"

  local install_output abort_output
  if ! install_output="$("$node_bin" "$ROOT/scripts/myclaude/install-hooks.mjs" \
      install --profile "$profile" --output "$MYCLAUDE_HOOK_SETTINGS" 2>&1)"; then
    if ! abort_output="$(bash "$MYCLAUDE_SERVER_MANAGER" profile-abort 2>&1)"; then
      flock -u "$profile_lock_fd" || true
      exec {profile_lock_fd}>&-
      printf '%s\n' "$install_output" >&2
      printf 'Error: hook installation failed and the previous daemon could not be restored: %s\n' "$abort_output" >&2
      return 1
    fi
    flock -u "$profile_lock_fd" || true
    exec {profile_lock_fd}>&-
    printf '%s\n' "$install_output" >&2
    return 1
  fi
  printf '%s\n' "$install_output"

  local apply_output rollback_output rollback_ok=true quiesce_output
  if ! apply_output="$(bash "$MYCLAUDE_SERVER_MANAGER" profile-applied "$profile" 2>&1)"; then
    # Stop any partially started new-profile daemon before restoring the old
    # hook file, so executor settings and daemon policy never diverge.
    if ! quiesce_output="$(bash "$MYCLAUDE_SERVER_MANAGER" profile-quiesce 2>&1)"; then
      flock -u "$profile_lock_fd" || true
      exec {profile_lock_fd}>&-
      printf '%s\n' "$apply_output" >&2
      printf 'Error: profile application failed and the partial daemon could not be stopped: %s\n' "$quiesce_output" >&2
      return 1
    fi
    if [[ "$previous_was_managed" == true ]]; then
      if ! rollback_output="$("$node_bin" "$ROOT/scripts/myclaude/install-hooks.mjs" \
          install --profile "$previous_profile" --output "$MYCLAUDE_HOOK_SETTINGS" 2>&1)"; then
        rollback_ok=false
      fi
    elif ! rollback_output="$("$node_bin" "$ROOT/scripts/myclaude/install-hooks.mjs" \
        remove --output "$MYCLAUDE_HOOK_SETTINGS" 2>&1)"; then
      rollback_ok=false
    fi
    if [[ "$rollback_ok" != true ]]; then
      flock -u "$profile_lock_fd" || true
      exec {profile_lock_fd}>&-
      printf '%s\n' "$apply_output" >&2
      printf 'Error: profile application failed and hook rollback failed; the daemon remains stopped: %s\n' "$rollback_output" >&2
      return 1
    fi
    if ! abort_output="$(bash "$MYCLAUDE_SERVER_MANAGER" profile-abort 2>&1)"; then
      flock -u "$profile_lock_fd" || true
      exec {profile_lock_fd}>&-
      printf '%s\n' "$apply_output" >&2
      printf 'Error: hooks were rolled back, but the previous daemon could not be restored: %s\n' "$abort_output" >&2
      return 1
    fi
    flock -u "$profile_lock_fd" || true
    exec {profile_lock_fd}>&-
    printf '%s\n' "$apply_output" >&2
    printf '%s\n' "Error: profile change failed and was rolled back to $previous_profile." >&2
    return 1
  fi
  [[ -z "$apply_output" ]] || printf '%s\n' "$apply_output"
  flock -u "$profile_lock_fd" || true
  exec {profile_lock_fd}>&-
  if [[ "$profile" == "host-unrestricted" ]]; then
    note "Warning: host-unrestricted can access any file and credential available to your Unix user."
  fi
}

resolve_direct_claude() {
  if [[ -n "${CLAUDE_BIN:-}" && -x "$CLAUDE_BIN" ]]; then
    printf '%s' "$CLAUDE_BIN"
    return 0
  fi
  if [[ -f "$CONNECTION_FILE" ]]; then
    # shellcheck disable=SC1090
    source "$CONNECTION_FILE"
    if [[ -x "${ORIGINAL_CLAUDE:-}" ]]; then
      printf '%s' "$ORIGINAL_CLAUDE"
      return 0
    fi
  fi
  if [[ -x "$USER_BIN_DIR/claude-anthropic" ]]; then
    printf '%s' "$USER_BIN_DIR/claude-anthropic"
    return 0
  fi
  local candidate
  candidate="$(command -v claude 2>/dev/null || true)"
  [[ -n "$candidate" && -x "$candidate" ]] || return 1
  if [[ "$candidate" == "$CLAUDE_WRAPPER" ]] && claude_is_connected; then
    return 1
  fi
  printf '%s' "$candidate"
}

run_myclaude() {
  if [[ "${MYCLAUDE_MANAGED_HOOKS_VERIFIED:-0}" != "1" ]]; then
    exec "$MYCLAUDE_BIN" "$@"
  fi
  local direct_claude
  direct_claude="$(resolve_direct_claude)" || die "Direct Claude Code is not installed or could not be resolved."
  if ! proxy_health; then
    start_proxy
  fi
  exec env CLAUDE_BIN="$direct_claude" bash "$ROOT/scripts/claude-local.sh" "$@"
}

write_claude_wrapper() {
  local destination="$1"
  local action="$2"
  printf '#!/usr/bin/env bash\n# M365_COPILOT_MANAGED_CLAUDE=1\nset -euo pipefail\nexec %q %q "$@"\n' \
    "$CONTROL_BIN" "$action" > "$destination"
  chmod 700 "$destination"
}

connect_claude() {
  ensure_private_dirs
  ensure_runtime

  # Older releases replaced ~/.local/bin/claude. Restore that command first so
  # provider selection is explicit forever: `claude` is direct, `myclaude` is M365.
  if claude_is_connected || [[ -f "$CONNECTION_FILE" ]]; then
    disconnect_claude
  fi
  resolve_direct_claude >/dev/null || die "Claude Code is not installed or is not on PATH. Install Claude Code first."
  node "$ROOT/scripts/claude-settings.mjs" clean-legacy "$STATE_DIR" || \
    die "Could not safely migrate legacy Claude proxy settings."
  install_myclaude
  note "Migration complete: claude is direct; myclaude uses the M365 proxy."
}

load_claude_connection() {
  [[ -f "$CONNECTION_FILE" ]] || die "Claude is not connected by this manager. Run: m365-copilot connect-claude"
  # shellcheck disable=SC1090
  source "$CONNECTION_FILE"
  [[ -x "$ORIGINAL_CLAUDE" ]] || die "Original Claude executable is missing: $ORIGINAL_CLAUDE"
}

disconnect_claude() {
  if [[ ! -f "$CONNECTION_FILE" ]]; then
    if claude_is_connected; then
      die "Managed Claude wrapper exists but its restore metadata is missing: $CONNECTION_FILE"
    fi
    note "Claude is already in normal/direct mode."
    return 0
  fi

  # shellcheck disable=SC1090
  source "$CONNECTION_FILE"
  claude_is_connected && rm -f "$CLAUDE_WRAPPER"
  if [[ -f "$CLAUDE_DIRECT_WRAPPER" ]] && grep -q '^# M365_COPILOT_MANAGED_CLAUDE=1$' "$CLAUDE_DIRECT_WRAPPER"; then
    rm -f "$CLAUDE_DIRECT_WRAPPER"
  fi

  case "$RESTORE_MODE" in
    moved)
      [[ -e "$BACKUP_PATH" || -L "$BACKUP_PATH" ]] || die "Original Claude backup is missing: $BACKUP_PATH"
      mv "$BACKUP_PATH" "$CLAUDE_WRAPPER"
      ;;
    symlink)
      ln -s "$ORIGINAL_CLAUDE" "$CLAUDE_WRAPPER"
      ;;
    shadow)
      ;;
    *)
      die "Unknown Claude restore mode: $RESTORE_MODE"
      ;;
  esac
  rm -f "$CONNECTION_FILE"
  note "Claude is disconnected. The normal Anthropic Claude command is restored."
}

run_claude_proxy() {
  note "[deprecated] Use myclaude. The ordinary claude command remains direct." >&2
  run_myclaude "$@"
}

run_claude_direct() {
  local direct_claude
  direct_claude="$(resolve_direct_claude)" || die "Direct Claude Code is not installed."
  unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_MODEL ANTHROPIC_SMALL_FAST_MODEL
  unset CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX
  exec "$direct_claude" "$@"
}

doctor() {
  local failures=0
  note "M365 Copilot Proxy doctor"
  note "Root: $ROOT"

  local command_name
  for command_name in bash npm curl; do
    if command -v "$command_name" >/dev/null 2>&1; then
      note "[ok] $command_name: $(command -v "$command_name")"
    else
      note "[missing] $command_name"
      failures=$((failures + 1))
    fi
  done

  if [[ -x "$ROOT/.runtime/node/node_modules/node/bin/node" ]]; then
    note "[ok] private Node runtime installed"
  else
    note "[missing] private Node runtime; run install"
    failures=$((failures + 1))
  fi
  if [[ -f "${XDG_CONFIG_HOME:-$HOME/.config}/opencode-m365/msal-cache.json" ]]; then
    note "[ok] Microsoft token cache exists"
  else
    note "[missing] Microsoft token cache; run login"
    failures=$((failures + 1))
  fi
  if proxy_health; then
    note "[ok] proxy is healthy"
  else
    note "[info] proxy is not running or is unhealthy"
  fi
  if claude_is_connected; then
    note "[warning] legacy Claude proxy wrapper is active; run connect-claude to migrate"
  elif command -v claude >/dev/null 2>&1; then
    note "[ok] Claude is installed in normal/direct mode"
  else
    note "[info] Claude Code is not installed"
  fi
  if [[ -L "$MYCLAUDE_WRAPPER" ]] && [[ "$(readlink "$MYCLAUDE_WRAPPER")" == "$MYCLAUDE_BIN" ]]; then
    note "[ok] myclaude launcher is installed"
  else
    note "[info] myclaude launcher is not installed; run install-myclaude"
  fi
  if [[ -n "${ANTHROPIC_AUTH_TOKEN:-}" && -n "${ANTHROPIC_API_KEY:-}" ]]; then
    note "[warning] both ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY are set in this shell"
  fi

  if (( failures > 0 )); then
    note "Doctor found $failures required item(s) to fix."
    return 1
  fi
  note "Doctor found no blocking installation problems."
}

uninstall_all() {
  local purge="${1:-}"
  if [[ -x "$MYCLAUDE_SERVER_MANAGER" ]]; then
    bash "$MYCLAUDE_SERVER_MANAGER" remove-service
  fi
  stop_proxy || true
  disconnect_claude || true
  remove_myclaude true || true
  remove_myclaude_research true || true
  remove_managed_hook_settings || true
  if [[ -L "$USER_BIN_DIR/m365-copilot" ]] && [[ "$(readlink "$USER_BIN_DIR/m365-copilot")" == "$CONTROL_BIN" ]]; then
    rm -f "$USER_BIN_DIR/m365-copilot"
  fi
  if [[ -f "$SYSTEMD_UNIT_FILE" ]] && grep -Fq "$ROOT/scripts/run-proxy-local.sh" "$SYSTEMD_UNIT_FILE"; then
    systemctl --user disable --now "$SYSTEMD_UNIT_NAME" 2>/dev/null || true
    rm -f "$SYSTEMD_UNIT_FILE"
    systemctl --user daemon-reload 2>/dev/null || true
  fi
  if [[ "$purge" == "--purge" ]]; then
    [[ "$CONFIG_DIR" == */m365-copilot-proxy ]] || die "Refusing to purge unexpected config path: $CONFIG_DIR"
    [[ "$STATE_DIR" == */m365-copilot-proxy ]] || die "Refusing to purge unexpected state path: $STATE_DIR"
    rm -rf -- "$CONFIG_DIR" "$STATE_DIR"
    note "Removed proxy configuration and logs. Microsoft token cache was preserved."
  fi
  note "Launchers removed. The downloaded repository and its private runtime were preserved."
}

command_name="${1:-help}"
shift || true
case "$command_name" in
  help|-h|--help) usage ;;
  install) install_all "$@" ;;
  login) login_interactive "$@" ;;
  login-device) login_device "$@" ;;
  start) start_proxy "$@" ;;
  stop) stop_proxy "$@" ;;
  restart) restart_proxy "$@" ;;
  status) status_all "$@" ;;
  logs) show_logs "$@" ;;
  models) list_models "$@" ;;
  install-myclaude) install_myclaude "$@" ;;
  remove-myclaude) remove_myclaude "$@" ;;
  install-research) install_myclaude_research "$@" ;;
  remove-research) remove_myclaude_research "$@" ;;
  profile) set_myclaude_profile "$@" ;;
  myclaude) run_myclaude "$@" ;;
  connect-claude) connect_claude "$@" ;;
  disconnect-claude) disconnect_claude "$@" ;;
  claude) run_claude_proxy "$@" ;;
  claude-direct) run_claude_direct "$@" ;;
  doctor) doctor "$@" ;;
  uninstall) uninstall_all "$@" ;;
  *) die "Unknown command: $command_name. Run: m365-copilot help" ;;
esac
