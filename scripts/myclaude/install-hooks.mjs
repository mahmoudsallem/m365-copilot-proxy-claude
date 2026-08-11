#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIRECTORY, "..", "..");
const TEMPLATE_PATH = path.join(ROOT, "config", "myclaude", "claude-hooks.json");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parse(argv) {
  const action = argv[0];
  const options = {};
  for (let index = 1; index < argv.length; index += 2) {
    if (!argv[index].startsWith("--") || argv[index + 1] === undefined) throw new Error(`invalid option: ${argv[index]}`);
    options[argv[index].slice(2)] = argv[index + 1];
  }
  return { action, options };
}

function outputPath(value) {
  const selected = value ?? path.join(
    process.env.XDG_CONFIG_HOME ? path.resolve(process.env.XDG_CONFIG_HOME) : path.join(os.homedir(), ".config"),
    "m365-copilot-proxy",
    "myclaude-hooks.json",
  );
  if (!path.isAbsolute(selected)) throw new Error("--output must be absolute");
  return path.resolve(selected);
}

function markerPath(filePath) {
  return `${filePath}.managed`;
}

function render(profile) {
  if (!["guarded", "host-unrestricted"].includes(profile)) throw new Error(`unsupported profile: ${profile}`);
  return fs.readFileSync(TEMPLATE_PATH, "utf8")
    .replaceAll("__MYCLAUDE_ROOT__", ROOT)
    .replaceAll("__MYCLAUDE_PROFILE__", profile);
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(filePath), 0o700); } catch {}
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, content, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

function readMarker(filePath) {
  try { return JSON.parse(fs.readFileSync(markerPath(filePath), "utf8")); } catch { return null; }
}

function currentDigest(filePath) {
  return fs.existsSync(filePath) ? sha256(fs.readFileSync(filePath)) : null;
}

function install(filePath, profile) {
  const existingMarker = readMarker(filePath);
  if (fs.existsSync(filePath) && (!existingMarker || currentDigest(filePath) !== existingMarker.digest)) {
    throw new Error(`refusing to overwrite unmanaged or modified settings: ${filePath}`);
  }
  const content = render(profile);
  const digest = sha256(content);
  atomicWrite(filePath, content);
  atomicWrite(markerPath(filePath), `${JSON.stringify({
    schema: "myclaude.managed-settings/v1",
    settingsPath: filePath,
    profile,
    digest,
  }, null, 2)}\n`);
  return { installed: true, settingsPath: filePath, profile, digest };
}

function remove(filePath) {
  const marker = readMarker(filePath);
  if (!marker) throw new Error(`refusing to remove settings without a managed marker: ${filePath}`);
  if (fs.existsSync(filePath) && currentDigest(filePath) !== marker.digest) {
    throw new Error(`refusing to remove locally modified settings: ${filePath}`);
  }
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  fs.unlinkSync(markerPath(filePath));
  return { removed: true, settingsPath: filePath };
}

function status(filePath) {
  const marker = readMarker(filePath);
  const digest = currentDigest(filePath);
  return {
    settingsPath: filePath,
    installed: Boolean(digest),
    managed: Boolean(marker),
    intact: Boolean(digest && marker?.digest === digest),
    profile: marker?.profile ?? null,
  };
}

try {
  const { action, options } = parse(process.argv.slice(2));
  const filePath = outputPath(options.output);
  const profile = options.profile ?? "guarded";
  let result;
  if (action === "render") {
    process.stdout.write(render(profile));
    process.exit(0);
  } else if (action === "install") result = install(filePath, profile);
  else if (action === "remove") result = remove(filePath);
  else if (action === "status") result = status(filePath);
  else throw new Error("Usage: install-hooks.mjs install|remove|status|render [--profile guarded|host-unrestricted] [--output /absolute/path]");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`install-hooks: ${error.message}\n`);
  process.exitCode = 2;
}
