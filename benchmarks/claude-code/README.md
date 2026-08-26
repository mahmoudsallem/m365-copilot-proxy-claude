# Claude Code agent benchmark

`cases.json` is the stable 20-case catalog and uses the metric vocabulary from
the compatibility mission. The existing offline Vitest/E2E suites cover every
protocol primitive without quota. `run-unfakeable.ps1` adds the most important
client-level proof: a random value absent from the prompt must travel through a
real Claude Code `Bash` execution and back through `tool_result` before it can
appear in the final answer.

```powershell
.\benchmarks\claude-code\run-unfakeable.ps1
```

The runner uses `M365_FAKE_MODE=1`, explicitly opts into Claude Code's permission
bypass only inside its disposable fixture, and writes timestamped JSON under
`out/`. Live M365 coverage remains a separate quota-conscious operation.

