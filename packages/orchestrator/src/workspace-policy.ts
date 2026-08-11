import { stat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, parse, relative, resolve } from "node:path";

export interface WorkspacePolicyOptions {
  scopeRoot?: string;
  allowedRoots?: string[];
  stateRoot?: string;
}

/** Canonicalize and reject workspaces that would turn a task into whole-host access. */
export async function assertWorkspaceAllowed(workspace: string, options: WorkspacePolicyOptions = {}): Promise<string> {
  if (!isAbsolute(workspace)) throw new Error("workspace must be an absolute path");
  const canonical = await realpath(workspace);
  if (!(await stat(canonical)).isDirectory()) throw new Error("workspace must be an existing directory");
  const homePaths = [...new Set([homedir(), process.env.HOME]
    .filter((value): value is string => Boolean(value))
    .map((value) => resolve(value)))];
  const exactForbidden = new Set([
    parse(canonical).root,
    ...homePaths,
    "/tmp", "/var/tmp", "/media", "/mnt",
  ].map((value) => resolve(value)));
  if (exactForbidden.has(canonical)) throw new Error(`workspace is too broad or protected: ${canonical}`);
  const containedHome = homePaths.find((home) => isWithin(home, canonical));
  if (containedHome) throw new Error(`workspace is broad enough to contain a home directory: ${containedHome}`);

  const protectedRoots = [
    "/boot", "/dev", "/etc", "/proc", "/root", "/run", "/sys", "/usr", "/var/lib", "/var/run",
    ...homePaths.flatMap((home) => [
      `${home}/.ssh`, `${home}/.gnupg`, `${home}/.aws`, `${home}/.azure`,
      `${home}/.config`, `${home}/.docker`, `${home}/.kube`, `${home}/.codex`,
      `${home}/.claude`, `${home}/.anthropic`,
      `${home}/.local/share/keyrings`, `${home}/.password-store`,
    ]),
    options.stateRoot,
  ].filter((value): value is string => Boolean(value)).map((value) => resolve(value));
  const protectedRoot = protectedRoots.find((root) => workspacesOverlap(canonical, root));
  if (protectedRoot) throw new Error(`workspace is inside protected path ${protectedRoot}`);

  const roots = [options.scopeRoot, ...(options.allowedRoots ?? [])]
    .filter((value): value is string => Boolean(value));
  if (roots.length > 0) {
    const canonicalRoots = await Promise.all(roots.map((root) => realpath(resolve(root))));
    if (!canonicalRoots.some((root) => isWithin(canonical, root))) {
      throw new Error(`workspace ${canonical} is outside the configured roots: ${canonicalRoots.join(", ")}`);
    }
  }
  return canonical;
}

export function workspacesOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

function isWithin(candidate: string, root: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
