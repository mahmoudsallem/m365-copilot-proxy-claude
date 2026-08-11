import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { sha256 } from "./util.js";

const execFileAsync = promisify(execFile);
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", ".cache", "target"]);

/** Fingerprint tracked changes and untracked contents, not merely HEAD. */
export async function computeWorkspaceFingerprint(workspace: string): Promise<string> {
  try {
    const { stdout: rootOutput } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: workspace, encoding: "utf8", maxBuffer: 2_000_000 });
    const root = rootOutput.trim();
    const [{ stdout: head }, { stdout: diff }, { stdout: untrackedOutput }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", maxBuffer: 2_000_000 }),
      execFileAsync("git", ["diff", "--binary", "--no-ext-diff", "HEAD", "--", "."], { cwd: root, encoding: "utf8", maxBuffer: 50_000_000 }),
      execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 20_000_000 }),
    ]);
    const untracked: Array<[string, string]> = [];
    for (const file of untrackedOutput.split("\0").filter(Boolean).sort()) {
      const content = await readFile(join(root, file));
      untracked.push([file, sha256(content.toString("base64"))]);
    }
    return `git-sha256:${sha256({ head: head.trim(), diff, untracked })}`;
  } catch {
    const files: Array<[string, string]> = [];
    await walk(workspace, workspace, files);
    return `fs-sha256:${sha256(files.sort(([left], [right]) => left.localeCompare(right)))}`;
  }
}

async function walk(root: string, directory: string, output: Array<[string, string]>): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(root, path, output);
    else if (entry.isFile()) {
      const metadata = await stat(path);
      if (metadata.size > 20_000_000) output.push([relative(root, path), `large:${metadata.size}:${metadata.mtimeMs}`]);
      else output.push([relative(root, path), sha256((await readFile(path)).toString("base64"))]);
    }
  }
}
