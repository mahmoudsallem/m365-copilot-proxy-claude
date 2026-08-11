import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertManagedHookSettings } from "./hook-settings.js";
import { sha256 } from "./util.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(profile: "guarded" | "host-unrestricted" = "guarded") {
  const root = await mkdtemp(join(tmpdir(), "myclaude-hook-policy-"));
  roots.push(root);
  const settingsPath = join(root, "settings.json");
  const body = `${JSON.stringify({
    env: { MYCLAUDE_EXECUTION_PROFILE: profile },
    hooks: Object.fromEntries(["PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "StopFailure"].map((name) => [name, [{}]])),
  }, null, 2)}\n`;
  await writeFile(settingsPath, body, { mode: 0o600 });
  await writeFile(`${settingsPath}.managed`, `${JSON.stringify({
    schema: "myclaude.managed-settings/v1", settingsPath, profile, digest: sha256(body),
  })}\n`, { mode: 0o600 });
  return settingsPath;
}

describe("managed Claude hook settings", () => {
  it("accepts an intact private marker with the daemon profile", async () => {
    await expect(assertManagedHookSettings(await fixture(), "guarded")).resolves.toBeUndefined();
  });

  it("fails closed on missing, modified, mismatched, or exposed settings", async () => {
    await expect(assertManagedHookSettings(undefined, "guarded")).rejects.toThrow(/MYCLAUDE_HOOK_SETTINGS/);
    const modified = await fixture();
    await writeFile(modified, `${await readFile(modified, "utf8")} `);
    await expect(assertManagedHookSettings(modified, "guarded")).rejects.toThrow(/digest/);
    const mismatch = await fixture("host-unrestricted");
    await expect(assertManagedHookSettings(mismatch, "guarded")).rejects.toThrow(/does not match/);
    const exposed = await fixture();
    await chmod(exposed, 0o644);
    await expect(assertManagedHookSettings(exposed, "guarded")).rejects.toThrow(/group\/world/);
  });
});
