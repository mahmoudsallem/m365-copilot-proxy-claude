import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import type { ProcessRunner } from "./runner.js";
import { NodeProcessRunner } from "./runner.js";
import { assertManagedHookSettings } from "./hook-settings.js";

export interface ModelEntry {
  id: string;
  [key: string]: unknown;
}

export async function fetchModels(options: { baseUrl?: string; apiKey?: string; fetch?: typeof globalThis.fetch } = {}): Promise<ModelEntry[]> {
  const baseUrl = (options.baseUrl ?? process.env.M365_PROXY_URL ?? "http://127.0.0.1:4141/v1").replace(/\/$/, "");
  const apiKey = options.apiKey ?? process.env.M365_PROXY_API_KEY;
  const response = await (options.fetch ?? globalThis.fetch)(`${baseUrl}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
  if (!response.ok) throw new Error(`proxy models request failed: ${response.status} ${await response.text()}`);
  const body = await response.json() as { data?: ModelEntry[] };
  if (!Array.isArray(body.data)) throw new Error("proxy returned an invalid models payload");
  return body.data.filter((entry) => entry && typeof entry.id === "string");
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runDoctor(options: { stateRoot: string; socketPath: string; runner?: ProcessRunner }): Promise<DoctorCheck[]> {
  const runner = options.runner ?? new NodeProcessRunner();
  const checks: DoctorCheck[] = [];
  try {
    const metadata = await stat(options.stateRoot);
    checks.push({ name: "state permissions", ok: (metadata.mode & 0o077) === 0, detail: `mode ${(metadata.mode & 0o777).toString(8)}` });
  } catch {
    checks.push({ name: "state directory", ok: false, detail: "not initialized; start the daemon" });
  }
  try {
    await access(options.socketPath, constants.R_OK | constants.W_OK);
    const metadata = await stat(options.socketPath);
    checks.push({ name: "daemon socket", ok: (metadata.mode & 0o077) === 0, detail: `${options.socketPath} mode ${(metadata.mode & 0o777).toString(8)}` });
  } catch {
    checks.push({ name: "daemon socket", ok: false, detail: `not reachable at ${options.socketPath}` });
  }
  for (const executable of ["claude", "codex"]) {
    try {
      const result = await runner.run({ executable, args: ["--version"], cwd: process.cwd(), timeoutMs: 10_000 });
      checks.push({ name: executable, ok: result.exitCode === 0, detail: (result.stdout || result.stderr).trim() });
    } catch (error) {
      checks.push({ name: executable, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  checks.push({
    name: "proxy executor",
    ok: Boolean(process.env.MYCLAUDE_EXECUTOR_BIN),
    detail: process.env.MYCLAUDE_EXECUTOR_BIN ?? "MYCLAUDE_EXECUTOR_BIN is not configured; daemon will fail loudly instead of using paid Claude",
  });
  const profile = process.env.MYCLAUDE_EXECUTION_PROFILE === "host-unrestricted" ? "host-unrestricted" : "guarded";
  try {
    await assertManagedHookSettings(process.env.MYCLAUDE_HOOK_SETTINGS, profile);
    checks.push({ name: "verified hooks", ok: true, detail: `${profile} managed settings are intact` });
  } catch (error) {
    checks.push({ name: "verified hooks", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  const bwrap = process.env.MYCLAUDE_BWRAP_BIN ?? "/usr/bin/bwrap";
  try {
    await access(bwrap, constants.X_OK);
    checks.push({ name: "validation sandbox", ok: true, detail: bwrap });
  } catch {
    checks.push({ name: "validation sandbox", ok: false, detail: `bubblewrap is required at ${bwrap}` });
  }
  try {
    const models = await fetchModels();
    checks.push({ name: "M365 proxy", ok: true, detail: `${models.length} models available` });
  } catch (error) {
    checks.push({ name: "M365 proxy", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  return checks;
}
