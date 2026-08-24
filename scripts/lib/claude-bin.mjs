import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * Locate the Claude Code CLI cross-platform.
 *
 * Order: $CLAUDE_BIN → platform default install locations → bare "claude" on PATH.
 * Windows: npm installs `claude.cmd` shims, and Node ≥18 refuses to spawn .cmd/.bat
 * without a shell (EINVAL), so callers must go through spawnClaude() below.
 */
export function resolveClaudeBin() {
  const env = process.env.CLAUDE_BIN;
  if (env) {
    if (existsSync(env)) return env;
    // CLAUDE_BIN set but missing — fall through to discovery rather than dying later.
  }
  const candidates = process.platform === "win32"
    ? [
        path.join(os.homedir(), "AppData", "Roaming", "npm", "claude.cmd"),
        path.join(os.homedir(), "AppData", "Local", "Programs", "claude-code", "claude.exe"),
        path.join(os.homedir(), ".local", "bin", "claude.exe"),
      ]
    : [path.join(os.homedir(), ".local", "bin", "claude")];
  for (const c of candidates) {
    try { if (existsSync(c) && statSync(c).isFile()) return c; } catch { /* keep looking */ }
  }
  return "claude";
}

const needsQuoting = (s: string) => /[\s"^&|<>()%!"]/test(s);
const quoteWin = (s: string) => `"${s.replace(/"/g, '""')}"`;

/**
 * Spawn the Claude CLI with Windows-correct semantics:
 * - POSIX → plain spawn(bin, args).
 * - win32 → single command string via shell:true (required for .cmd shims),
 *   with cmd.exe-safe quoting. Note: cmd.exe env-var expansion means %…% in
 *   args would be substituted — callers should not pass untrusted text as
 *   flag VALUES here without knowing that.
 */
export function spawnClaude(
  args,
  opts = {},
): ReturnType<typeof spawn> {
  const bin = resolveClaudeBin();
  if (process.platform !== "win32") {
    return spawn(bin, args, { ...opts, stdio: opts.stdio ?? "inherit" });
  }
  const cmdline = [needsQuoting(bin) ? quoteWin(bin) : bin, ...args.map((a) => (needsQuoting(a) ? quoteWin(a) : a))].join(" ");
  return spawn(cmdline, { ...opts, shell: true, stdio: opts.stdio ?? "inherit" });
}
