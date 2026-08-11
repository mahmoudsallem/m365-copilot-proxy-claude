#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEMPLATE = path.join(ROOT, "config", "myclaude", "myclauded.service.in");

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parse(argv) {
  const action = argv[0];
  const options = {};
  for (let index = 1; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || argv[index + 1] === undefined) throw new Error(`invalid option: ${argv[index]}`);
    options[argv[index].slice(2)] = argv[index + 1];
  }
  return { action, options };
}

function absolute(value, label) {
  if (!value || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return path.resolve(value);
}

function quoteSystemd(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function paths(options) {
  const output = options.output
    ? absolute(options.output, "--output")
    : path.join(os.homedir(), ".config", "systemd", "user", "myclauded.service");
  const socket = options.socket
    ? absolute(options.socket, "--socket")
    : path.join(process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), ".local", "state"), "m365-copilot-proxy", "myclauded.sock");
  return { output, socket };
}

function render(executable, socket) {
  return fs.readFileSync(TEMPLATE, "utf8")
    .replaceAll("__MYCLAUDED_EXECUTABLE__", quoteSystemd(executable))
    .replaceAll("__MYCLAUDE_SOCKET__", quoteSystemd(socket));
}

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, value, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function marker(filePath) {
  try { return JSON.parse(fs.readFileSync(`${filePath}.managed`, "utf8")); } catch { return null; }
}

function fileDigest(filePath) {
  return fs.existsSync(filePath) ? digest(fs.readFileSync(filePath)) : null;
}

try {
  const { action, options } = parse(process.argv.slice(2));
  const { output, socket } = paths(options);
  const managed = marker(output);
  if (action === "status") {
    const actual = fileDigest(output);
    process.stdout.write(`${JSON.stringify({ output, socket, installed: Boolean(actual), managed: Boolean(managed), intact: Boolean(actual && actual === managed?.digest) }, null, 2)}\n`);
  } else if (action === "render" || action === "install") {
    const executable = absolute(options.executable, "--executable");
    const content = render(executable, socket);
    if (action === "render") process.stdout.write(content);
    else {
      if (fs.existsSync(output) && (!managed || fileDigest(output) !== managed.digest)) throw new Error(`refusing to overwrite unmanaged or modified unit: ${output}`);
      atomicWrite(output, content);
      atomicWrite(`${output}.managed`, `${JSON.stringify({ schema: "myclaude.managed-service/v1", digest: digest(content), executable, socket }, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify({ installed: true, output, executable, socket, activation: "systemctl --user daemon-reload && systemctl --user enable --now myclauded.service" }, null, 2)}\n`);
    }
  } else if (action === "remove") {
    if (!managed) throw new Error(`refusing to remove unit without managed marker: ${output}`);
    if (fs.existsSync(output) && fileDigest(output) !== managed.digest) throw new Error(`refusing to remove modified unit: ${output}`);
    if (fs.existsSync(output)) fs.unlinkSync(output);
    fs.unlinkSync(`${output}.managed`);
    process.stdout.write(`${JSON.stringify({ removed: true, output, deactivation: "systemctl --user disable --now myclauded.service && systemctl --user daemon-reload" }, null, 2)}\n`);
  } else throw new Error("Usage: install-service.mjs install|remove|status|render --executable /absolute/myclaude [--socket /absolute/socket] [--output /absolute/unit]");
} catch (error) {
  process.stderr.write(`install-service: ${error.message}\n`);
  process.exitCode = 2;
}
