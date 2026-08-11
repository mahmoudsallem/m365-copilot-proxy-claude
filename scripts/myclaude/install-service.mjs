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
  if (/[\0\r\n]/u.test(value)) throw new Error("systemd values must not contain NUL or line breaks");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

function paths(options) {
  const output = options.output
    ? absolute(options.output, "--output")
    : path.join(os.homedir(), ".config", "systemd", "user", "myclauded.service");
  const socket = options.socket
    ? absolute(options.socket, "--socket")
    : path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "m365-copilot-proxy", "myclauded.sock");
  return { output, socket };
}

function configuration(options, executable, socket) {
  const stateRoot = options["state-root"]
    ? absolute(options["state-root"], "--state-root")
    : path.dirname(socket);
  const configDir = options["config-dir"]
    ? absolute(options["config-dir"], "--config-dir")
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "m365-copilot-proxy");
  const hookSettings = options["hook-settings"]
    ? absolute(options["hook-settings"], "--hook-settings")
    : path.join(configDir, "myclaude-hooks.json");
  const localEnv = options["local-env"]
    ? absolute(options["local-env"], "--local-env")
    : path.join(configDir, "proxy.env");
  const executor = options.executor ? absolute(options.executor, "--executor") : executable;
  const executorArgs = options["executor-args"] ?? "";
  if (executorArgs) {
    let parsed;
    try { parsed = JSON.parse(executorArgs); } catch { throw new Error("--executor-args must be a JSON string array"); }
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new Error("--executor-args must be a JSON string array");
    }
  }
  const profile = options.profile ?? "guarded";
  if (!["guarded", "host-unrestricted"].includes(profile)) throw new Error("--profile must be guarded or host-unrestricted");
  const executorResume = options["executor-resume"] ?? "1";
  if (!["0", "1"].includes(executorResume)) throw new Error("--executor-resume must be 0 or 1");
  const concurrency = options.concurrency ?? "1";
  if (!/^[1-4]$/u.test(concurrency)) throw new Error("--concurrency must be an integer from 1 through 4");
  const allowedWorkspaceRoots = options["allowed-workspace-roots"] ?? "";
  const bwrapBin = options["bwrap-bin"] ?? "/usr/bin/bwrap";
  if (bwrapBin && !path.isAbsolute(bwrapBin)) throw new Error("--bwrap-bin must be an absolute path");
  return {
    stateRoot,
    configDir,
    localEnv,
    hookSettings,
    executor,
    executorArgs,
    profile,
    executorResume,
    concurrency,
    allowedWorkspaceRoots,
    bwrapBin,
  };
}

function render(executable, socket, service) {
  return fs.readFileSync(TEMPLATE, "utf8")
    .replaceAll("__MYCLAUDED_EXECUTABLE__", quoteSystemd(executable))
    .replaceAll("__MYCLAUDE_SOCKET__", quoteSystemd(socket))
    .replaceAll("__MYCLAUDE_STATE_ROOT__", quoteSystemd(service.stateRoot))
    .replaceAll("__M365_STATE_DIR__", quoteSystemd(service.stateRoot))
    .replaceAll("__M365_CONFIG_DIR__", quoteSystemd(service.configDir))
    .replaceAll("__M365_LOCAL_ENV__", quoteSystemd(service.localEnv))
    .replaceAll("__MYCLAUDE_HOOK_SETTINGS__", quoteSystemd(service.hookSettings))
    .replaceAll("__MYCLAUDE_EXECUTION_PROFILE__", quoteSystemd(service.profile))
    .replaceAll("__MYCLAUDE_EXECUTOR_BIN__", quoteSystemd(service.executor))
    .replaceAll("__MYCLAUDE_EXECUTOR_ARGS__", quoteSystemd(service.executorArgs))
    .replaceAll("__MYCLAUDE_EXECUTOR_RESUME__", quoteSystemd(service.executorResume))
    .replaceAll("__MYCLAUDE_CONCURRENCY__", quoteSystemd(service.concurrency))
    .replaceAll("__MYCLAUDE_ALLOWED_WORKSPACE_ROOTS__", quoteSystemd(service.allowedWorkspaceRoots))
    .replaceAll("__MYCLAUDE_BWRAP_BIN__", quoteSystemd(service.bwrapBin));
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
    const service = configuration(options, executable, socket);
    const content = render(executable, socket, service);
    if (action === "render") process.stdout.write(content);
    else {
      if (fs.existsSync(output) && (!managed || fileDigest(output) !== managed.digest)) throw new Error(`refusing to overwrite unmanaged or modified unit: ${output}`);
      atomicWrite(output, content);
      atomicWrite(`${output}.managed`, `${JSON.stringify({ schema: "myclaude.managed-service/v1", digest: digest(content), executable, socket, ...service }, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify({ installed: true, output, executable, socket, ...service, activation: `systemctl --user daemon-reload && systemctl --user enable --now ${path.basename(output)}` }, null, 2)}\n`);
    }
  } else if (action === "remove") {
    if (!managed) throw new Error(`refusing to remove unit without managed marker: ${output}`);
    if (fs.existsSync(output) && fileDigest(output) !== managed.digest) throw new Error(`refusing to remove modified unit: ${output}`);
    if (fs.existsSync(output)) fs.unlinkSync(output);
    fs.unlinkSync(`${output}.managed`);
    process.stdout.write(`${JSON.stringify({ removed: true, output, deactivation: `systemctl --user disable --now ${path.basename(output)} && systemctl --user daemon-reload` }, null, 2)}\n`);
  } else throw new Error("Usage: install-service.mjs install|remove|status|render --executable /absolute/myclaude [--socket /absolute/socket] [--state-root /absolute/state] [--config-dir /absolute/config] [--local-env /absolute/proxy.env] [--hook-settings /absolute/settings] [--executor /absolute/executable] [--executor-args JSON] [--profile guarded|host-unrestricted] [--executor-resume 0|1] [--concurrency 1..4] [--allowed-workspace-roots PATHS] [--bwrap-bin /absolute/bwrap] [--output /absolute/unit]");
} catch (error) {
  process.stderr.write(`install-service: ${error.message}\n`);
  process.exitCode = 2;
}
