# Claude Code through the local M365 proxy

The standalone proxy exposes an Anthropic Messages compatibility endpoint at
`POST /v1/messages`, plus `POST /v1/messages/count_tokens`. This lets Claude Code use
the M365-backed model catalog without reading or replacing Claude's stored subscription
credentials.

## Install and start

From the repository:

```sh
./install.sh
./login.sh
./start-proxy.sh
```

Then, from the project Claude Code may access:

```sh
myclaude                    # M365-backed Claude Code
claude                      # unchanged direct Anthropic Claude
```

Choose another proxy model for one session with `MODEL`, for example:

```sh
MODEL=quick myclaude
```

The managed `myclaude` wrapper points `ANTHROPIC_BASE_URL` at localhost, reads the
generated bearer token from the existing mode-0600 `proxy.env`, disables nonessential
Anthropic traffic, and limits the advertised Claude Code tools to Bash, Read, Edit,
Write, Glob, and Grep. Every launch sends a cryptographically random
`X-M365-Session-ID`, so separate workers cannot share transcripts. The distributed
default is a guarded evidence-hook profile; select the explicitly unsafe, observation-only
whole-host profile with `myclaude profile host-unrestricted`.

The installer never replaces the original `claude` command and never silently falls
back to it. Older installations that did replace `claude` can run
`m365-copilot connect-claude` once: despite its legacy name, this restores direct
Claude and installs the separate `myclaude` command. Restart an already-running
terminal session after changing launchers or profiles.

The connector does not set both `apiKeyHelper` and `ANTHROPIC_AUTH_TOKEN`. During
migration it removes only legacy localhost proxy fields from global Claude settings,
backs up the original JSON, and leaves unrelated theme, permission, and model settings
untouched.

## Verified tasks and planner handoff

Interactive `myclaude` is still available, but durable work should go through the
artifact-first executor:

```sh
myclaude server start
myclaude task start --planner codex --workspace "$PWD" --task "Fix the failing tests"
myclaude task status RUN_ID --watch
myclaude task evidence RUN_ID
```

Use `--planner claude` for direct Claude or `--planner none` with one or more
`--validate` commands when supplying the plan locally. Medium/high-risk work, failed
checks, large diffs, and plan deviations enter a bounded review/repair loop. The model
cannot mark itself passed; deterministic validation and the orchestrator own final
state. Direct Claude and Codex can submit and inspect the same task protocol through
the narrow MCP integration:

```sh
myclaude integrate add claude
myclaude integrate add codex
myclaude integrate status claude
```

The MCP server exposes task lifecycle operations, not raw shell or credential access.
Its stdio transport negotiates MCP `2025-06-18`, requires the initialized lifecycle,
suppresses notification responses, returns tool failures as structured MCP errors,
and can cancel a pending `task_wait` request.
See [MyClaude verified execution](myclaude-verified.md) for hooks, evidence, grounded
research, evaluation, and promotion gates.

## Important limitations

- This is wire compatibility, not an Anthropic model guarantee. The selected model is
  whichever undocumented M365 tone/route the proxy resolves. Picker labels report
  `verified`, `experimental`, or `broken`; the current catalog has no
  production-certified route, and `claude-opus` is excluded from automatic routing.
- M365 tool calling is prompt-emulated. It is less reliable than Claude's native tool
  API, and the proxy intentionally keeps the tool set lean because large tool schemas
  can trigger `Disengaged`.
- The Messages bridge buffers each M365 turn before emitting Anthropic content blocks.
  It sends SSE heartbeats while the upstream turn is running, but text is not token-live.
- `/v1/messages/count_tokens` is a character-based estimate because M365 does not expose
  a matching tokenizer.
- Microsoft account/tenant policy and current M365 service health still control whether
  a request succeeds. The bridge cannot bypass Conditional Access, licensing, throttling,
  or an M365 upstream server error.
- Empty/disengaged M365 turns are exposed as bounded failures. This prevents
  Claude Code's automatic retries from consuming many messages on a dead conversation;
  retry manually after waiting or restarting the session.
- Claude Code 2.1.129 or newer discovers the proxy catalog in `/model`. The picker shows
  the clean M365 IDs and labels them `From gateway`; transport-only `claude-m365--...`
  aliases are translated back to the exact selected M365 ID by the proxy. Claude Code's
  unavoidable `Default` entry is pinned to the wrapper's `MODEL` value. The wrapper
  permits only its localhost model-discovery request even if global Claude settings set
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`; telemetry and error reporting remain off.

Keep the proxy bound to `127.0.0.1`. Do not expose the endpoint or its bearer token over
the network.
