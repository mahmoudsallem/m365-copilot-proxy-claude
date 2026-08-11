import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertWorkspaceAllowed, workspacesOverlap } from "./workspace-policy.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("workspace policy", () => {
  it("accepts only canonical directories under an optional configured root", async () => {
    const root = await mkdtemp(join(tmpdir(), "myclaude-workspace-policy-"));
    roots.push(root);
    const allowed = join(root, "allowed");
    const workspace = join(allowed, "project");
    const sibling = join(root, "sibling");
    await mkdir(workspace, { recursive: true });
    await mkdir(sibling);
    await expect(assertWorkspaceAllowed(workspace, { allowedRoots: [allowed] })).resolves.toBe(workspace);
    await expect(assertWorkspaceAllowed(sibling, { allowedRoots: [allowed] })).rejects.toThrow(/outside/);
  });

  it("rejects broad, state, and symlinked protected workspaces", async () => {
    await expect(assertWorkspaceAllowed("/")).rejects.toThrow(/too broad/);
    const root = await mkdtemp(join(tmpdir(), "myclaude-workspace-state-"));
    roots.push(root);
    const state = join(root, "state");
    await mkdir(state);
    await expect(assertWorkspaceAllowed(state, { stateRoot: state })).rejects.toThrow(/protected/);
    const link = join(root, "state-link");
    await symlink(state, link, "dir");
    await expect(assertWorkspaceAllowed(link, { stateRoot: state })).rejects.toThrow(/protected/);
  });

  it("detects equal and nested workspace leases", () => {
    expect(workspacesOverlap("/work/a", "/work/a")).toBe(true);
    expect(workspacesOverlap("/work/a", "/work/a/sub")).toBe(true);
    expect(workspacesOverlap("/work/a", "/work/ab")).toBe(false);
  });
});
