#!/usr/bin/env node
// Clone or update the public system-prompts corpus into vendor/system-prompts-leaks
// so the proxy's system-prompt library (packages/core/src/prompts.ts) can index it.
//
//   node scripts/fetch-system-prompts.mjs           # clone or pull
//   node scripts/fetch-system-prompts.mjs --list    # also print indexed names
//
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = process.env.SYSTEM_PROMPTS_REPO ?? "https://github.com/asgeirtj/system_prompts_leaks.git";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dest = path.join(root, "vendor", "system-prompts-leaks");

fs.mkdirSync(path.dirname(dest), { recursive: true });

if (fs.existsSync(path.join(dest, ".git"))) {
  console.log(`[system-prompts] updating ${dest}`);
  execFileSync("git", ["-C", dest, "pull", "--ff-only"], { stdio: "inherit" });
} else {
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  console.log(`[system-prompts] cloning ${REPO} -> ${dest}`);
  execFileSync("git", ["clone", "--depth", "1", REPO, dest], { stdio: "inherit" });
}

if (process.argv.includes("--list")) {
  const { listSystemPrompts } = await import("../packages/core/dist/index.mjs");
  const prompts = listSystemPrompts();
  console.log(`[system-prompts] ${prompts.length} prompt(s) indexed:`);
  for (const p of prompts) console.log(`  ${p.name} (${p.chars} chars)`);
}
