import fs from "node:fs";
import path from "node:path";
import { createLogger } from "./log.js";

const log = createLogger("prompts");

/**
 * System-prompt library.
 *
 * Indexes a local checkout of a system-prompts corpus (default:
 * <repo>/vendor/system-prompts-leaks, populated by scripts/fetch-system-prompts.mjs
 * from github.com/asgeirtj/system_prompts_leaks) plus any directory given via
 * M365_SYSTEM_PROMPTS_DIR. Prompts are addressable by NAME (relative path without
 * extension) and injectable per request via the `x-m365-system-prompt` header, the
 * M365_SYSTEM_PROMPT env var, or the TUI.
 *
 * Injection is OPT-IN and happens in @m365-copilot/proxy-lib's handler: big injected
 * prompts raise Disengaged risk (docs AGENTS.md), so nothing is added unless asked.
 */

export interface SystemPromptMeta {
  /** Addressable name — relative path inside the corpus, extension stripped. */
  name: string;
  /** Where the entry came from. */
  source: "builtin" | "leaks";
  /** Size in characters (loaded lazily, so this is from the last index scan). */
  chars: number;
}

const TEXT_EXTENSIONS = new Set([".md", ".mdx", ".txt"]);
const MAX_PROMPT_BYTES = 512 * 1024;
const MAX_SCAN_DEPTH = 6;

function promptsRoots(): string[] {
  const roots: string[] = [];
  if (process.env.M365_SYSTEM_PROMPTS_DIR) roots.push(process.env.M365_SYSTEM_PROMPTS_DIR);
  // Module-relative: packages/core/dist -> repo root/vendor/...
  roots.push(path.resolve(import.meta.dirname ?? ".", "../../../vendor/system-prompts-leaks"));
  // CWD-relative fallback (tests / running from repo root).
  roots.push(path.resolve(process.cwd(), "vendor/system-prompts-leaks"));
  return roots;
}

let cachedIndex: { root: string; entries: Map<string, string> } | null = null;

function indexRoot(root: string): Map<string, string> {
  const entries = new Map<string, string>(); // name -> absolute file path
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_SCAN_DEPTH) return;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (dirent.name.startsWith(".")) continue;
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!dirent.isFile() || !TEXT_EXTENSIONS.has(path.extname(dirent.name).toLowerCase())) continue;
      let size = 0;
      try { size = fs.statSync(full).size; } catch { continue; }
      if (size === 0 || size > MAX_PROMPT_BYTES) continue;
      const rel = path.relative(root, full);
      const name = rel.replace(/\.(md|mdx|txt)$/i, "").split(path.sep).join("/");
      if (!entries.has(name)) entries.set(name, full);
    }
  };
  walk(root, 0);
  return entries;
}

/** Locate + index the corpus. Returns null when no corpus directory exists. */
export function findSystemPromptIndex(): { root: string; entries: Map<string, string> } | null {
  if (cachedIndex) return cachedIndex;
  for (const root of promptsRoots()) {
    if (!fs.existsSync(root)) continue;
    const entries = indexRoot(root);
    if (entries.size === 0) continue;
    log.info(`Indexed ${entries.size} system prompts from ${root}`);
    cachedIndex = { root, entries };
    return cachedIndex;
  }
  return null;
}

/** Test/introspection hook — drop the memoized corpus index. */
export function clearSystemPromptCache(): void {
  cachedIndex = null;
}

/** List available prompts (metadata only; text loads lazily). */
export function listSystemPrompts(): SystemPromptMeta[] {
  const index = findSystemPromptIndex();
  if (!index) return [];
  const out: SystemPromptMeta[] = [];
  for (const [name, file] of index.entries) {
    let chars = 0;
    try { chars = fs.statSync(file).size; } catch { /* vanished mid-scan */ }
    out.push({ name, source: "leaks", chars });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Load one prompt by exact name. */
export function getSystemPrompt(name: string): string | null {
  const index = findSystemPromptIndex();
  const file = index?.entries.get(name);
  if (!file) return null;
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err: any) {
    log.warn(`Failed reading system prompt "${name}": ${err.message}`);
    return null;
  }
}

/**
 * Resolve a prompt SPEC into text. Precedence:
 *   1. "name:<x>"  → corpus lookup (fails loudly when missing)
 *   2. "path:<p>"  → read an arbitrary file
 *   3. bare value  → corpus name → existing path → LITERAL text
 * Returns null for empty specs. Throws only for explicit name:/path: misses so
 * misconfiguration surfaces as a 400 instead of silently wrong behaviour.
 */
export function resolveSystemPromptSpec(spec: string): { text: string; mode: "name" | "path" | "literal" } | null {
  const trimmed = spec.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("name:")) {
    const name = trimmed.slice(5).trim();
    const text = getSystemPrompt(name);
    if (text == null) throw new Error(`Unknown system prompt name "${name}". Available: ${listSystemPrompts().slice(0, 20).map((p) => p.name).join(", ") || "(none indexed)"}`);
    return { text, mode: "name" };
  }

  if (trimmed.startsWith("path:")) {
    const p = trimmed.slice(5).trim();
    try {
      return { text: fs.readFileSync(p, "utf8"), mode: "path" };
    } catch (err: any) {
      throw new Error(`Failed reading system prompt path "${p}": ${err.message}`);
    }
  }

  const byName = getSystemPrompt(trimmed);
  if (byName != null) return { text: byName, mode: "name" };

  if (trimmed.includes("/") || /\.(md|mdx|txt)$/i.test(trimmed)) {
    try {
      return { text: fs.readFileSync(trimmed, "utf8"), mode: "path" };
    } catch { /* fall through to literal */ }
  }

  return { text: trimmed, mode: "literal" };
}
