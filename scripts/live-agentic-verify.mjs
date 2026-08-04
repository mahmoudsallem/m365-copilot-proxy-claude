// Live end-to-end agentic verification against M365.
// Uses the Anthropic Messages bridge with Claude Code's uppercase `Bash` tool:
//   1. Ask M365 to list files.
//   2. Require a tool_use response.
//   3. Execute that Bash command locally.
//   4. Send the tool_result back in the same conversation.
//   5. Require a final answer grounded in the tool output.
//
// This spends real M365 quota. Run sequentially; do not loop it.

import { execFileSync } from "node:child_process";
import {
  getToken,
  createLogger,
} from "../packages/core/dist/index.mjs";
import {
  AnthropicMessagesRequest,
  SessionPool,
  handleAnthropicMessages,
} from "../packages/proxy-lib/dist/index.mjs";

const log = createLogger("live-agentic-verify");
const pool = new SessionPool();
const model = process.env.M365_VERIFY_MODEL ?? "claude-sonnet";

const tools = [{
  name: "Bash",
  description: "Run a shell command in the repository root.",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Command to execute" },
    },
    required: ["command"],
  },
}];

async function anthropic(body) {
  const parsed = AnthropicMessagesRequest.parse(body);
  const res = await handleAnthropicMessages(parsed, pool);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 500)}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

function findToolUse(message) {
  return (message.content ?? []).find((block) => block.type === "tool_use");
}

function textContent(message) {
  return (message.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function runBash(command) {
  const output = execFileSync("bash.exe", ["-lc", command], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  return output.trim();
}

console.log("[live-agentic] warming auth");
await getToken();
console.log(`[live-agentic] auth OK, model=${model}`);

const first = await anthropic({
  model,
  max_tokens: 4096,
  tools,
  tool_choice: { type: "any", disable_parallel_tool_use: true },
  messages: [{
    role: "user",
    content: "List the files in the current repository. Use Bash; do not answer from memory.",
  }],
});

console.log(`[live-agentic] turn1 stop_reason=${first.stop_reason}`);
console.log(`[live-agentic] turn1 content=${JSON.stringify(first.content).slice(0, 1000)}`);
const toolUse = findToolUse(first);
if (!toolUse) {
  throw new Error(`Expected tool_use on turn 1, got: ${JSON.stringify(first.content)}`);
}
if (toolUse.name !== "Bash") {
  throw new Error(`Expected Bash tool_use, got ${toolUse.name}`);
}

const command = String(toolUse.input?.command ?? "");
if (!command.trim()) {
  throw new Error(`Bash tool_use missing command: ${JSON.stringify(toolUse)}`);
}
console.log(`[live-agentic] executing Bash command: ${command}`);
const toolOutput = runBash(command);
console.log(`[live-agentic] tool output sample=${JSON.stringify(toolOutput.slice(0, 1000))}`);

const second = await anthropic({
  model,
  max_tokens: 4096,
  tools,
  messages: [
    {
      role: "user",
      content: "List the files in the current repository. Use Bash; do not answer from memory.",
    },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: toolUse.id, name: toolUse.name, input: toolUse.input }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUse.id, content: toolOutput }],
    },
  ],
});

const finalText = textContent(second);
console.log(`[live-agentic] turn2 stop_reason=${second.stop_reason}`);
console.log(`[live-agentic] final=${JSON.stringify(finalText).slice(0, 1200)}`);

if (second.stop_reason !== "end_turn") {
  throw new Error(`Expected final end_turn, got ${second.stop_reason}`);
}
if (!/package\.json|packages|scripts|docs|README/i.test(finalText)) {
  throw new Error("Final answer did not appear grounded in the repository listing.");
}

log.info("Live agentic verification passed");
console.log("[live-agentic] PASS");
