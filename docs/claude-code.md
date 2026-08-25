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
./connect-claude.sh
```

Then, from the project Claude Code may access:

```sh
claude
```

Choose another proxy model for one session with `MODEL`, for example:

```sh
MODEL=quick claude
```

The managed `claude` wrapper points `ANTHROPIC_BASE_URL` at localhost, reads the
generated bearer token from the existing mode-0600 `proxy.env`, disables nonessential
Anthropic traffic, and limits the advertised Claude Code tools to Bash, Read, Edit,
Write, Glob, and Grep. Normal Claude Code permissions still apply. The manager keeps
restore metadata under `~/.local/state/m365-copilot-proxy/`.

The original installed binary is preserved. Use `claude-direct` when temporarily
returning to the Claude.ai/Max provider, or run `m365-copilot disconnect-claude` to
restore the plain `claude` command permanently. Restart Claude Code after switching;
an already-running session keeps the provider it started with. The saved Claude.ai
login may remain visible in `claude auth status`, but model requests use the gateway
whenever the managed wrapper is connected to `127.0.0.1:4141`.

The connector does not set both `apiKeyHelper` and `ANTHROPIC_AUTH_TOKEN`. During
migration it removes only legacy localhost proxy fields from global Claude settings,
backs up the original JSON, and leaves unrelated theme, permission, and model settings
untouched.

## Important limitations

- This is wire compatibility, not an Anthropic model guarantee. The selected model is
  whichever M365 tone/model the proxy resolves.
- M365 tool calling is prompt-emulated. It is less reliable than Claude's native tool
  API, and the proxy intentionally keeps the tool set lean because large tool schemas
  can trigger `Disengaged`.
- Streaming is genuinely incremental for prose: text deltas are forwarded as they
  arrive (with a short holdback window in tool mode so fence bytes never leak).
  Tool-call blocks and thinking blocks are emitted once the turn's fences are parsed.
- `/v1/messages/count_tokens` is a character-based estimate because M365 does not expose
  a matching tokenizer.
- Microsoft account/tenant policy and current M365 service health still control whether
  a request succeeds. The bridge cannot bypass Conditional Access, licensing, throttling,
  or an M365 upstream server error.
- Empty/disengaged M365 turns are exposed as non-retryable errors. This prevents
  Claude Code's automatic retries from consuming many messages on a dead conversation;
  retry manually after waiting or restarting the session.
- Claude Code's `/model` picker contains Anthropic subscription models, not the M365
  catalog. Unsupported picker IDs fall back to `gpt-5.5` (override with
  `M365_CLAUDE_CODE_MODEL`); explicit M365 model IDs pass through.
- Every launcher process injects its own `x-m365-session-id` header
  (`ANTHROPIC_CUSTOM_HEADERS`). Distinct CLI processes — or hosts — therefore never
  fuse into one shared M365 conversation, even with identical first prompts.
- M365 conversations survive proxy restarts: the pool persists ConversationId +
  delta position to `~/.config/opencode-m365/sessions.json` and rehydrates on the
  next request with the same conversation fingerprint (disable with
  `M365_NO_SESSION_STORE=1`).

Keep the proxy bound to `127.0.0.1`. Do not expose the endpoint or its bearer token over
the network.
