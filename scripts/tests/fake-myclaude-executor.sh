#!/usr/bin/env bash
set -euo pipefail

# Deterministic stand-in for Claude Code.  It keeps an execution active long
# enough for lifecycle tests to exercise profile-change exclusion without any
# provider or network call.
sleep "${MYCLAUDE_TEST_EXECUTOR_DELAY:-2}"
printf '%s\n' '{"type":"result","result":"fake execution complete","num_turns":1,"messages":1}'
