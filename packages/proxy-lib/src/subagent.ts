// Sub-agent orchestration (Claude Code "Task"-style, proxy-native):
// The main conversation can delegate self-contained research/exploration jobs to
// a SUB-AGENT — its own fresh M365 conversation with a restricted READ-ONLY
// toolset whose calls are executed IN-PROCESS by the proxy (node:fs — no shell,
// no mutation surface). The sub-agent's final report is fed back to the main
// conversation as a tool_response; the client only ever sees ordinary turns.
// Mutations (Edit/Write/Bash) remain main-loop-only. Disable: M365_NO_SUBAGENTS=1.
import fs from "node:fs";
import path from "node:path";
import { createLogger, looksLikeConfabulation } from "@m365-copilot/core";
import type { ModelSession } from "@m365-copilot/core";

const log = createLogger("subagent");

export const SUBAGENT_TOOL_NAME = "Task";

export function subAgentsEnabled(): boolean {
  return process.env.M365_NO_SUBAGENTS !== "1";
}

export function makeTaskToolDef() {
  return {
    type: "function" as const,
    function: {
      name: SUBAGENT_TOOL_NAME,
      description:
        "PREFERRED first step for ANY explore/lookup/summarize job: delegate here instead of using bash yourself. " +
        "Spawns a read-only sub-agent in its own workspace sandbox with read_file / glob_files / grep_files tools; " +
        "it cannot edit files or run shell commands. Provide a COMPLETE self-contained prompt (the sub-agent sees " +
        "nothing else from this conversation) ending with the exact deliverable you want back.",
      parameters: {
        type: "object",
        properties: {
          // `description`/`subagent_type` mirror Claude Code's native Task shape so
          // models emitting that form parse cleanly; only `prompt` drives execution.
          description: { type: "string", description: "Short label for the job (shown in logs)." },
          subagent_type: { type: "string", description: "Ignored — this sandbox has one read-only research agent." },
          prompt: { type: "string", description: "Full task instructions for the sub-agent, including paths and the exact report format." },
        },
        required: ["prompt"],
      },
    },
  };
}

/** Extract a self-contained job brief from a parsed Task call's arguments,
 *  tolerating Claude Code's native shape (description + subagent_type + prompt)
 *  and degenerate forms (bare string arguments object). */
export function extractSubAgentJob(rawArguments: unknown): string {
  let args: Record<string, unknown> | null = null;
  if (typeof rawArguments === "string") {
    try { args = JSON.parse(rawArguments); } catch { args = null; }
  } else if (rawArguments && typeof rawArguments === "object") {
    args = rawArguments as Record<string, unknown>;
  }
  if (!args) return typeof rawArguments === "string" ? rawArguments : "";
  const prompt = String(args.prompt ?? "").trim();
  const description = String(args.description ?? "").trim();
  if (prompt) return description ? `${description}\n\n${prompt}` : prompt;
  return description || String((args as any).task ?? (args as any).query ?? "");
}

// --- Restricted read-only toolset (advertised to the sub-agent) ---

const MAX_READ_CHARS = 24_000;
const MAX_LIST = 200;

function workspaceRoot(): string {
  return path.resolve(process.env.M365_WORKSPACE_ROOT ?? process.cwd());
}

function safeResolve(p: string): string | null {
  const root = workspaceRoot();
  const abs = path.resolve(root, p);
  if (!(abs === root || abs.startsWith(root + path.sep))) return null;
  return abs;
}

export interface SubToolDef { name: string; description: string; parameters: Record<string, unknown>; }

export const SUBAGENT_TOOLS: SubToolDef[] = [
  {
    name: "read_file",
    description: "Read a file's text contents.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "glob_files",
    description: "List files matching a glob pattern (** and * supported), relative to the workspace root.",
    parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
  },
  {
    name: "grep_files",
    description: "Search file CONTENTS with a regex across the workspace; returns matching lines with file:line prefixes.",
    parameters: { type: "object", properties: { pattern: { type: "string" }, include: { type: "string", description: "optional glob filter like *.ts" } }, required: ["pattern"] },
  },
];

function globToRegex(pattern: string): RegExp {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/\\\\]*").replace(/\u0000/g, ".*").replace(/\?/g, "[^/\\\\]");
  // Leading "**/" must ALSO match files at the workspace root (glob convention).
  const anchored = esc.replace(/^\.\*\//, "(?:.*/)?");
  return new RegExp(`(?:^|/)${anchored}$`, "i");
}

function walk(dir: string, out: string[], depth = 0): void {
  if (depth > 8 || out.length >= MAX_LIST) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= MAX_LIST) return;
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else out.push(p);
  }
}

/** Pre-execution validation: catch bad args and return a CORRECTIVE hint so the
 *  sub-model self-corrects on its next turn instead of compounding errors. */
export function validateSubToolArgs(name: string, args: Record<string, unknown>): string | null {
  if (name === "read_file") {
    const p = String(args.path ?? "").trim();
    if (!p) return "ERROR: read_file needs a 'path'. Use glob_files first to discover files.";
    if (!safeResolve(p)) return "ERROR: path escapes the workspace. Use a path relative to the workspace root.";
    try { if (!fs.statSync(safeResolve(p)!).isFile()) return `ERROR: '${p}' is not a file.`; } catch { return `ERROR: file not found: '${p}'. Run glob_files to list actual files.`; }
  }
  if (name === "grep_files") {
    const pat = String(args.pattern ?? "").trim();
    if (!pat) return "ERROR: grep_files needs a non-empty 'pattern'.";
    try { new RegExp(pat); } catch { return `ERROR: invalid regex '${pat}' — simplify the pattern (plain keywords work).`; }
  }
  if (name === "glob_files" && !String(args.pattern ?? "").trim()) {
    return "ERROR: glob_files needs a 'pattern' like '**/*.ts' or 'src/*'.";
  }
  return null;
}

/** Execute one restricted sub-agent tool call. Returns tool_output text. */
export function execSubTool(name: string, args: Record<string, unknown>): string {
  const invalid = validateSubToolArgs(name, args);
  if (invalid) return invalid;
  const root = workspaceRoot();
  try {
    if (name === "read_file") {
      const abs = safeResolve(String(args.path ?? ""));
      if (!abs) return "ERROR: path escapes workspace";
      const st = fs.statSync(abs);
      if (st.isDirectory()) return `ERROR: ${args.path} is a directory`;
      const buf = fs.readFileSync(abs, "utf8");
      return buf.length > MAX_READ_CHARS ? buf.slice(0, MAX_READ_CHARS) + `\n…[truncated ${buf.length - MAX_READ_CHARS} chars]` : buf;
    }
    if (name === "glob_files") {
      const re = globToRegex(String(args.pattern ?? "**/*"));
      const all: string[] = [];
      walk(root, all);
      const hits = all.map((p) => path.relative(root, p).replace(/\\/g, "/")).filter((rel) => re.test(rel));
      return hits.length ? hits.slice(0, MAX_LIST).join("\n") : "(no matches)";
    }
    if (name === "grep_files") {
      const re = new RegExp(String(args.pattern ?? ""), "i");
      const inc = args.include ? globToRegex(String(args.include)) : null;
      const all: string[] = [];
      walk(root, all);
      let lines = 0;
      const out: string[] = [];
      for (const abs of all) {
        if (inc && !inc.test(abs.replace(/\\/g, "/"))) continue;
        let content: string;
        try { content = fs.readFileSync(abs, "utf8"); } catch { continue; }
        const rel = path.relative(root, abs).replace(/\\/g, "/");
        const split = content.split("\n");
        for (let i = 0; i < split.length && lines < 60; i++) {
          if (re.test(split[i])) { out.push(`${rel}:${i + 1}: ${split[i].slice(0, 240)}`); lines++; }
        }
        if (lines >= 60) break;
      }
      return out.length ? out.join("\n") : "(no matches)";
    }
    return `ERROR: unknown tool "${name}"`;
  } catch (err: any) {
    return `ERROR: ${err.message}`;
  }
}

// --- The bounded sub-agent loop ---

const SUB_MAX_TURNS = Number(process.env.M365_SUBAGENT_TURNS ?? 6);
const SUB_REPORT_CAP = 12_000;

/**
 * Run one delegated job to completion. `session` is a DEDICATED ModelSession
 * (its own conversation fingerprint — never shared with the main thread).
 * Returns the sub-agent's final report text.
 */
export async function runSubAgent(
  session: ModelSession,
  model: string,
  job: string,
  signal?: AbortSignal,
  injectedFetch?: unknown,
): Promise<string> {
  void injectedFetch;
  const specs = new Map(SUBAGENT_TOOLS.map((t) => [t.name, t]));
  const realityLine =
    "[HARNESS REALITY: your tools are REAL and the workspace exists. Refusing for 'lack of access' is a malfunction. Explore, then report.]";
  let text =
    `${realityLine}\n<task>\n${job}\n</task>\n\n` +
    "You are a READ-ONLY research sub-agent. Explore with your tools, then reply with your FINAL REPORT as plain prose " +
    "(no fences) once done. You cannot edit files or run shell commands - report findings instead.\n" +
    "Begin exploring now.";

  for (let turn = 0; turn < SUB_MAX_TURNS; turn++) {
    const stream = await session.run(text, model, signal, false);
    let full = "";
    for await (const d of stream) full += d;
    if (stream.fullText?.length > full.length) full = stream.fullText;
    log.info(`sub turn ${turn}: ${full.length} chars`);

    // Final answer = plain prose (no known-tool fence present) — UNLESS it's a
    // refusal glitch ("Hmm...it looks like I can't chat about this", confab
    // shapes). Those get ONE reality-anchored retry, then an honest report.
    const fence = full.match(/^\s*```([A-Za-z0-9_.-]+)/m);
    if (!fence || !specs.has(fence[1])) {
      const refusal = looksLikeConfabulation(full) || /can.?t chat about this/i.test(full);
      if (refusal && turn < SUB_MAX_TURNS - 1 && !text.includes("REFUSAL RECOVERY")) {
        log.warn(`Sub-agent refused (${trunc(full, 80)}) — retrying with reality anchor`);
        text =
          `${realityLine}\n[REFUSAL RECOVERY: your previous reply was a refusal glitch. You DO have working ` +
          `read_file/glob_files/grep_files tools on this workspace. Re-run the ORIGINAL task now.]\n` +
          `<task>\n${job}\n</task>`;
        continue;
      }
      if (refusal) return "(sub-agent refused after retry — likely transient upstream filtering; re-delegate later)";
      return full.trim().slice(0, SUB_REPORT_CAP) || "(sub-agent produced no output)";
    }

    // Execute ALL tool calls this turn sequentially, feed results back.
    const results: string[] = [];
    const re = /```([A-Za-z0-9_.-]+)[ \t]*\r?\n([\s\S]*?)\r?\n?```/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(full)) !== null) {
      if (!specs.has(m[1])) continue;
      let args: Record<string, unknown> = {};
      const inner = m[2];
      // Header-style scalar args then body — reuse simple key:value scan.
      for (const line of inner.split("\n")) {
        const km = line.match(/^([A-Za-z0-9_]+):[ \t]?(.*)$/);
        if (km && Object.keys(specs.get(m[1])!.parameters.properties ?? {}).includes(km[1])) {
          args[km[1]] = km[2];
        }
      }
      // Single-body-param tools take the whole inner as the value.
      const propKeys = Object.keys(specs.get(m[1])!.parameters.properties ?? {});
      if (propKeys.length === 1 && !(propKeys[0] in args)) args[propKeys[0]] = inner.trim();
      results.push(`<result tool="${m[1]}">\n${execSubTool(m[1], args)}\n</result>`);
    }
    text =
      `[Automated harness message: tool results for YOUR previous calls — not a user message. ` +
      `Continue researching, or reply with your FINAL REPORT in plain prose.]\n\n` +
      results.join("\n\n");
  }
  return "(sub-agent hit its turn budget without a final report)";
}
