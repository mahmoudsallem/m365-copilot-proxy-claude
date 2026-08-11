# MyClaude verified execution

MyClaude's verified layer makes an M365-backed Claude Code session measurable and
recoverable. It does **not** fine-tune the upstream model and does not claim that
an M365 tone is Anthropic Opus. The executor may say it is finished; only an
objective verifier or the orchestrator may mark a run `passed`.

This document covers the standalone tooling in `scripts/myclaude/`. The daemon,
SDK, MCP server, plan schema, and public `myclaude task` commands live in the
orchestrator package and use the same run directory and evidence contracts.

## Claude Code hooks

The hook dispatcher implements the current Claude Code `PreToolUse`,
`PostToolUse`, `PostToolUseFailure`, `Stop`, and `StopFailure` contracts. See
[Anthropic's hook reference](https://code.claude.com/docs/en/hooks) for the
upstream event schema.

Generate a private settings file without changing `~/.claude/settings.json`:

```bash
node scripts/myclaude/install-hooks.mjs install \
  --profile guarded \
  --output "$HOME/.config/m365-copilot-proxy/myclaude-hooks.json"
```

The launcher passes that file to Claude Code with `--settings`. It also exports:

```text
MYCLAUDE_RUN_DIR=/absolute/private/run/directory
MYCLAUDE_WORKSPACE=/absolute/project/root
MYCLAUDE_EXECUTION_PROFILE=guarded|host-unrestricted
MYCLAUDE_STOP_MAX_BLOCKS=2
```

The installer is reversible and refuses to overwrite or remove a file that is
unmanaged or changed after installation:

```bash
node scripts/myclaude/install-hooks.mjs status
node scripts/myclaude/install-hooks.mjs remove
```

### Profiles

- `guarded` is the public default. Built-in file tools (`Read`, `Write`, `Edit`,
  and related tools) are restricted to the selected workspace. Bash is covered
  only by a best-effort denylist and Claude Code's normal permission behavior;
  recognized destructive operations, credential-store access, publishing, and
  force pushes are denied.
- `host-unrestricted` evaluates and records the same rules but emits no
  permission decision. Claude Code's selected permission mode remains in
  control. This is the observation-only profile for the owner's trusted host.

The guarded rules are defense in depth, not a shell sandbox or security
boundary. Under normal OS permissions, Bash can express paths and operations
that a regular-expression denylist cannot reliably contain. Use a container or
worktree with restricted credentials when strong isolation is required.
`host-unrestricted` provides auditing only.

### Evidence and the Stop gate

Each hook session has a mode-0700 directory containing:

- `evidence.jsonl`: redacted, hash-chained events with mode 0600.
- `hook-state.json`: mutation, verification, stop-block, and failure state.
- `verification.json`: optional external verifier result written atomically by
  the orchestrator.

Raw environment variables are never recorded. Known bearer tokens, JWTs, API
keys, passwords, cookies, and secret-shaped values are redacted from previews.
Commands and tool responses also have SHA-256 digests so evidence can be
correlated without relying on the preview.

A successful recognized test, lint, build, or typecheck after the latest change
clears the local dirty state. The orchestrator can instead write:

```json
{
  "schema": "myclaude.verification/v1",
  "status": "passed",
  "verifiedAt": "2026-08-11T12:00:00.000Z",
  "commands": [
    { "commandHash": "sha256...", "exitCode": 0 }
  ]
}
```

`verifiedAt` must be at or after the most recent mutation. When unverified
changes remain, the Stop hook asks Claude to continue. The hook blocks at most
`MYCLAUDE_STOP_MAX_BLOCKS` times (default two, maximum seven); after that it
allows the turn to end as `partial`. This is intentionally bounded and stays
below Claude Code's own eight-block override.

Inspect and verify evidence with:

```bash
node scripts/myclaude/evidence-status.mjs /absolute/run/directory
```

`StopFailure` cannot control Claude Code. It records the upstream error type and
a redacted digest so the orchestrator can resume or mark the run failed.

## Grounded research helper

`myclaude-research` is one narrow local command, keeping the prompt-emulated M365
tool schema small. Research uses its own random M365 session and never shares the
coding transcript.

### Authenticated localhost proxy provider

Start the proxy normally so `M365_PROXY_API_KEY` is exported, then run:

```bash
node scripts/myclaude/myclaude-research.mjs search \
  --provider proxy \
  --base-url http://127.0.0.1:4141/v1 \
  --query "current primary documentation for the feature"
```

The provider:

1. Connects only to `localhost`, authenticates with `M365_PROXY_API_KEY`, and
   sends no OpenAI/Claude tool definitions, keeping the M365 turn agent-less.
2. Uses a fresh `X-M365-Session-ID` so research cannot corrupt a coding session.
3. Accepts sources only from returned `sourceAttributions` metadata. The bridge
   exposes this as `usage.x_m365_source_attributions`; compatible nested forms
   are also accepted.
4. Rejects a response with no source metadata. URLs written in answer prose are
   never promoted into the source ledger.

The API key is used only in the request header and is never returned or logged.
Tests use a localhost fake proxy and do not call live M365.

### Mock and external adapters

Deterministic tests use an absolute JSON fixture:

```bash
node scripts/myclaude/myclaude-research.mjs search \
  --provider mock --fixture /absolute/research-fixture.json \
  --query "current package docs" --ledger /absolute/run/research
```

An external adapter can be selected with `--provider command
--provider-command /absolute/executable`. It receives this JSON on stdin:

```json
{
  "schema": "myclaude.research-provider/v1",
  "action": "search",
  "request": { "query": "..." }
}
```

It returns `{ "answer": "...", "sources": [{ "url": "..." }] }`. The helper
uses `spawn` without a shell and removes credential-shaped environment variables
before invoking the adapter. An adapter must use its own private credential
store if authentication is required.

### Citation validation

The source ledger records a canonical URL, source ID, title, redacted excerpt,
provider, retrieval time, and content hash for each returned attribution.
Secret-shaped query parameters and tracking parameters are removed.

```bash
node scripts/myclaude/myclaude-research.mjs validate \
  --ledger /absolute/run/research \
  --input answer.md --require-citations
node scripts/myclaude/myclaude-research.mjs verify \
  --ledger /absolute/run/research
```

Markdown/bare URLs and `[[source:src_...]]` references pass only when they match
the returned ledger. Any fabricated or merely model-generated URL fails.

## Service helper

`config/myclaude/myclauded.service.in` is a hardened user-service template. Once
the orchestrator CLI exists at an absolute path, install a managed unit:

```bash
node scripts/myclaude/install-service.mjs install \
  --executable "$HOME/.local/bin/myclaude"
systemctl --user daemon-reload
systemctl --user enable --now myclauded.service
```

The low-level helper only writes/removes its exact managed unit. The public
`install.sh`, `myclaude server start|stop|restart|status`, and `uninstall.sh`
commands manage `systemctl --user` when it is available and use a PID-verified
detached fallback otherwise. `status` validates the unit digest; uninstall will
not stop or delete a locally modified unit. Profile changes are locked
transactions: active work causes a refusal, and an idle daemon is restarted with
rollback if hook installation fails.

## Certification catalog and promotion gates

The 37-task catalog in `scripts/bench/verified-tasks.mjs` covers:

- TypeScript, multi-file bugs, refactors, and long-context retrieval.
- Nested CommonMark fences, tool failure recovery, and grounded research.
- Clarification/correction behavior and plan dependency execution.
- Unsafe prompts, output truncation/checkpointing, and daemon/API recovery.

Validate or export the catalog without consuming M365 quota:

```bash
node scripts/bench/verified-catalog.mjs validate
node scripts/bench/verified-catalog.mjs list
node scripts/bench/verified-catalog.mjs json
```

### Sequential evaluation runner

`verified-runner.mjs` materializes every selected fixture in a new mode-0700
temporary Git repository, invokes exactly one adapter at a time, runs its
objective verifier, and atomically checkpoints `myclaude.eval-results/v1` after
every row. A per-user process lock prevents two runner instances from consuming
quota concurrently. Order is randomized from a recorded seed and `--resume`
skips completed `(phase, system, mode, task, repetition)` keys.

An offline smoke/evaluation uses the deterministic mock adapter:

```bash
node scripts/bench/verified-runner.mjs \
  --output /absolute/mock-results.json \
  --system myclaude \
  --adapter mock \
  --mock-fixture /absolute/myclaude.eval-mock.json \
  --task mf-cache-key \
  --repetitions 2 \
  --isolation local \
  --seed review-1
```

Mock fixtures use `myclaude.eval-mock/v1`. Each `tasks.<id>` record may provide
replacement `files`, `answer`, `trace`, policy/citation evidence, and metrics.
Mock rows exercise the fixture/verifier machinery but the analyzer explicitly
rejects them as certification or shadow evidence.

Live command adapters are never selected implicitly and require `--live`:

```bash
node scripts/bench/verified-runner.mjs \
  --output /absolute/certification.json \
  --system myclaude \
  --adapter command \
  --live \
  --mode adaptive \
  --task mf-cache-key \
  --repetitions 1 \
  --isolation docker \
  --unit-integration-failures 0

node scripts/bench/verified-runner.mjs \
  --output /absolute/certification.json \
  --system direct-claude \
  --adapter command \
  --live \
  --mode adaptive \
  --task mf-cache-key \
  --repetitions 1 \
  --isolation docker \
  --unit-integration-failures 0 \
  --resume
```

The defaults invoke `myclaude` and `claude` in non-interactive JSON mode.
`--myclaude-command`, `--direct-claude-command`, and their repeatable `--*-arg`
options support controlled wrapper adapters. The runner sends the task prompt on
stdin and exports `MYCLAUDE_EVAL_REQUEST`, pointing to a private
`myclaude.eval-adapter-request/v1` file with the complete task/fault contract.
A wrapper may return structured fields such as `trace`, `faultEvents`, and
`deniedTools`; the verifier captures the resulting diagnostic evidence.
Research certification ignores adapter-reported `sourceIds`, `citedUrls`, and
`ungroundedUrls`. The evaluator
parses citations from the final answer and grounds them against the
evaluator-owned `research-fixture.json` source ledger; every unknown source marker
or URL is counted as fabricated even when the adapter claims otherwise.

The stock Claude/MyClaude command itself does not inject synthetic
command-not-found, stale-edit, forced-output, API, or daemon-restart faults.
Fault-bearing tasks therefore fail closed unless a wrapper/hook actually reports
the declared fault outcome in `faultEvents`. The runner never invents recovery
evidence from a successful exit.

Every adapter/verifier invocation owns a process group. A timeout terminates and
then force-kills the full tree before the next row starts; a timed-out Docker
verifier is also removed by its exact random container name.

Objective command verifiers run in Docker with `--network none`, a read-only
fixture mount, dropped capabilities, and no-new-privileges whenever the selected
image is already present. The runner never pulls an image. Live certification
fails closed if Docker/the image is unavailable; local verifier execution is
allowed only for offline mock runs (and explicitly non-certifying workflows).
This isolates the verifier, not the command adapter itself: a live Claude process
still has the permissions of the invoking Unix user unless it is separately
sandboxed. Rows now record `agentIsolation` and `verifierIsolation` separately.
The built-in command adapter records `agentIsolation=host`, refuses the explicit
unsafe-prompt cases, and therefore **cannot satisfy the promotion gate**. A future
or external adapter must run the agent itself in a disposable isolated environment
with brokered credentials and report `agentIsolation=docker`; Docker-verifying only
the result is deliberately insufficient.

The runner records `myclaude.eval-results/v1`; the analyzer never trusts a
claimed completion unless `status=passed` and `verifierPassed=true`:

```json
{
  "schema": "myclaude.eval-results/v1",
  "unitIntegrationFailures": 0,
  "execution": {
    "sequential": true,
    "randomized": true,
    "maxConcurrent": 1
  },
  "runs": [
    {
      "system": "myclaude",
      "mode": "adaptive",
      "taskId": "mf-cache-key",
      "repetition": 1,
      "status": "passed",
      "verifierPassed": true,
      "messages": 12,
      "toolCalls": 7,
      "malformedToolCalls": 0,
      "fabricatedCitations": 0,
      "silentFalseSuccess": false,
      "unrecoveredUpstreamFailure": false,
      "agentIsolation": "docker",
      "verifierIsolation": "docker"
    }
  ]
}
```

Analyze an offline result artifact:

```bash
node scripts/bench/verified-analyze.mjs \
  --results /absolute/results.json --phase certification
node scripts/bench/verified-analyze.mjs \
  --results /absolute/shadow.json --phase shadow
```

Certification is denied unless all plan gates pass: green local tests, complete
catalog coverage, five passing repetitions and zero failed repetitions for every critical task, at least 95% verified
completion, at least 90% of direct Claude's rate, zero silent false-successes in
at least 150 runs, under 1% malformed tools, zero fabricated citations, and no
more than 2.5x adaptive message cost. Shadow promotion requires 100 tasks or
seven days, zero silent false-successes, and under 5% unrecovered upstream
failures.

The catalog, offline mock adapter, and analyzer do not spend quota or claim
certification by themselves. Only explicit `--adapter command --live` runs call
MyClaude or direct Claude. Certification still requires the full randomized
sequential matrix and the later shadow rollout; a small runner smoke is not a
production claim.
