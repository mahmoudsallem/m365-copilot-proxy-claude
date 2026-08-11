#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  appendEvent,
  privateDirectory,
  redactText,
  sha256,
  verifyLedger,
} from "./evidence-lib.mjs";

const SECRET_QUERY_KEY = /(?:api[_-]?key|auth|cookie|credential|mfa|pass(?:word)?|secret|signature|sig|token)/i;
const TRACKING_QUERY_KEY = /^(?:utm_.+|fbclid|gclid|mc_[ce]id)$/i;

function usage() {
  return `Usage:
  myclaude-research search --query TEXT [--provider proxy|mock|command]
  myclaude-research fetch --url URL [--provider proxy|mock|command]
  myclaude-research validate --input FILE [--require-citations]
  myclaude-research list
  myclaude-research verify

Provider options:
  proxy   --base-url http://127.0.0.1:4141/v1 --model quick
          Reads M365_PROXY_API_KEY from the environment; never prints it.
  mock    --fixture /absolute/path/to/fixture.json
  command --provider-command /absolute/path/to/adapter

All commands accept --ledger DIR. The default is the current MyClaude run's
research directory or a private per-workspace state directory.`;
}

function parseArguments(argv) {
  const command = argv[0];
  const values = {};
  const flags = new Set();
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    if (["--require-citations", "--json"].includes(token)) {
      flags.add(token.slice(2));
      continue;
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`${token} requires a value`);
    values[token.slice(2)] = value;
  }
  return { command, values, flags };
}

function ledgerDirectory(explicit) {
  if (explicit) {
    if (!path.isAbsolute(explicit)) throw new Error("--ledger must be an absolute path");
    return privateDirectory(path.resolve(explicit));
  }
  if (process.env.MYCLAUDE_RUN_DIR) {
    if (!path.isAbsolute(process.env.MYCLAUDE_RUN_DIR)) throw new Error("MYCLAUDE_RUN_DIR must be absolute");
    return privateDirectory(path.join(path.resolve(process.env.MYCLAUDE_RUN_DIR), "research"));
  }
  const stateBase = process.env.XDG_STATE_HOME
    ? path.resolve(process.env.XDG_STATE_HOME)
    : path.join(os.homedir(), ".local", "state");
  const workspaceId = sha256(process.cwd()).slice(0, 20);
  return privateDirectory(path.join(stateBase, "m365-copilot-proxy", "research", workspaceId));
}

function canonicalUrl(value) {
  let parsed;
  try { parsed = new URL(String(value)); } catch { throw new Error("provider returned an invalid source URL"); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("source URL must use http or https");
  if (parsed.username || parsed.password) throw new Error("source URL must not contain credentials");
  parsed.hash = "";
  for (const key of [...parsed.searchParams.keys()]) {
    if (SECRET_QUERY_KEY.test(key) || TRACKING_QUERY_KEY.test(key)) parsed.searchParams.delete(key);
  }
  return parsed.toString();
}

function firstString(object, keys) {
  for (const key of keys) {
    if (typeof object?.[key] === "string" && object[key].trim()) return object[key].trim();
  }
  return null;
}

function normalizeSource(raw) {
  if (!raw || typeof raw !== "object") return null;
  const nested = [raw, raw.attribution, raw.source, raw.reference, raw.metadata].filter(Boolean);
  let url = null;
  let title = null;
  let excerpt = null;
  let provider = null;
  for (const candidate of nested) {
    url ??= firstString(candidate, ["url", "seeMoreUrl", "sourceUrl", "webUrl", "href", "link"]);
    title ??= firstString(candidate, ["title", "displayName", "name", "providerDisplayName"]);
    excerpt ??= firstString(candidate, ["snippet", "excerpt", "summary", "description"]);
    provider ??= firstString(candidate, ["provider", "providerDisplayName", "sourceType"]);
  }
  if (!url) return null;
  const normalizedUrl = canonicalUrl(url);
  const contentHash = sha256(excerpt ?? normalizedUrl);
  return {
    sourceId: `src_${sha256(`${normalizedUrl}\n${contentHash}`).slice(0, 20)}`,
    url: normalizedUrl,
    title: redactText(title ?? new URL(normalizedUrl).hostname, 300),
    excerpt: excerpt ? redactText(excerpt, 1_200) : null,
    provider: redactText(provider ?? "unknown", 100),
    contentHash,
  };
}

function deduplicateSources(rawSources) {
  const unique = new Map();
  for (const raw of rawSources ?? []) {
    const source = normalizeSource(raw);
    if (source && !unique.has(source.url)) unique.set(source.url, source);
  }
  return [...unique.values()];
}

function readFixture(filePath) {
  if (!filePath || !path.isAbsolute(filePath)) throw new Error("mock provider requires an absolute --fixture path");
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!parsed || typeof parsed !== "object") throw new Error("fixture must be a JSON object");
  return parsed;
}

function mockProvider(action, request, options) {
  const fixture = readFixture(options.fixture);
  if (action === "search") {
    const candidates = Array.isArray(fixture.search)
      ? fixture.search.find((item) => item.query === request.query)
      : fixture.search?.[request.query];
    if (!candidates) throw new Error("mock fixture has no matching search result");
    return { answer: candidates.answer ?? "", sources: candidates.sources ?? candidates };
  }
  const candidate = Array.isArray(fixture.fetch)
    ? fixture.fetch.find((item) => item.url === request.url)
    : fixture.fetch?.[request.url];
  if (!candidate) throw new Error("mock fixture has no matching fetch result");
  return { answer: candidate.answer ?? candidate.content ?? "", sources: candidate.sources ?? [candidate] };
}

function providerEnvironment() {
  const output = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/(?:TOKEN|SECRET|PASSWORD|PASS|COOKIE|CREDENTIAL|AUTH|API_?KEY)/i.test(key)) continue;
    output[key] = value;
  }
  return output;
}

function commandProvider(action, request, options) {
  const executable = options["provider-command"];
  if (!executable || !path.isAbsolute(executable)) throw new Error("command provider requires an absolute --provider-command");
  const result = spawnSync(executable, [], {
    input: JSON.stringify({ schema: "myclaude.research-provider/v1", action, request }),
    encoding: "utf8",
    env: providerEnvironment(),
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
    shell: false,
  });
  if (result.error) throw new Error(`research provider failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`research provider exited ${result.status}`);
  const payload = JSON.parse(result.stdout);
  return { answer: payload.answer ?? "", sources: payload.sources ?? payload.sourceAttributions ?? [] };
}

function findAttributions(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 7) return [];
  for (const [key, item] of Object.entries(value)) {
    if (["sourceAttributions", "source_attributions", "x_m365_source_attributions"].includes(key) && Array.isArray(item)) {
      if (item.length > 0) return item;
    }
  }
  for (const item of Object.values(value)) {
    const found = findAttributions(item, depth + 1);
    if (found.length > 0) return found;
  }
  return [];
}

async function proxyProvider(action, request, options) {
  const base = new URL(options["base-url"] ?? process.env.MYCLAUDE_RESEARCH_BASE_URL ?? "http://127.0.0.1:4141/v1");
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(base.hostname)) {
    throw new Error("proxy research provider only connects to localhost");
  }
  if (!["http:", "https:"].includes(base.protocol)) throw new Error("proxy base URL must use http or https");
  const apiKey = process.env.M365_PROXY_API_KEY;
  if (!apiKey) throw new Error("M365_PROXY_API_KEY is required for the proxy provider");
  const subject = action === "search"
    ? `Search the web for this query and answer only from returned Bing sources: ${request.query}`
    : `Open and summarize this exact web URL using web grounding: ${request.url}`;
  const response = await fetch(new URL(`${base.pathname.replace(/\/$/, "")}/chat/completions`, base), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "X-M365-Session-ID": crypto.randomUUID(),
    },
    body: JSON.stringify({
      model: options.model ?? process.env.MYCLAUDE_RESEARCH_MODEL ?? "quick",
      stream: false,
      messages: [
        {
          role: "system",
          content: "You are a web research worker. Use Bing grounding. State only claims supported by retrieved sources. Do not invent citations or URLs.",
        },
        { role: "user", content: subject },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const detail = redactText(await response.text(), 300);
    throw new Error(`localhost proxy returned HTTP ${response.status}: ${detail}`);
  }
  const payload = await response.json();
  const sources = findAttributions(payload);
  if (sources.length === 0) {
    throw new Error("localhost proxy returned no sourceAttributions; ungrounded model links were rejected");
  }
  return { answer: payload.choices?.[0]?.message?.content ?? "", sources };
}

async function callProvider(action, request, options) {
  const provider = options.provider ?? process.env.MYCLAUDE_RESEARCH_PROVIDER ?? "proxy";
  if (provider === "mock") return { provider, ...(mockProvider(action, request, options)) };
  if (provider === "command") return { provider, ...(commandProvider(action, request, options)) };
  if (provider === "proxy") return { provider, ...(await proxyProvider(action, request, options)) };
  throw new Error(`unknown provider: ${provider}`);
}

function recordSources(directory, action, request, response) {
  const sources = deduplicateSources(response.sources);
  if (sources.length === 0) throw new Error("provider returned no valid source URLs");
  const requestHash = sha256(JSON.stringify(request));
  appendEvent(directory, {
    type: "research.request",
    action,
    provider: response.provider,
    requestHash,
    returnedSourceCount: sources.length,
  });
  for (const source of sources) {
    appendEvent(directory, {
      type: "research.source",
      action,
      provider: response.provider,
      requestHash,
      retrievedAt: new Date().toISOString(),
      source,
    });
  }
  return sources;
}

function readSourceLedger(directory) {
  const filePath = path.join(directory, "evidence.jsonl");
  if (!fs.existsSync(filePath)) return [];
  const sources = new Map();
  for (const line of fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "research.source" && event.source?.url && event.source?.sourceId) {
      sources.set(event.source.sourceId, event.source);
    }
  }
  return [...sources.values()];
}

function citationsFrom(text) {
  const citations = [];
  for (const match of text.matchAll(/\[\[source:(src_[a-f0-9]{20})\]\]/gi)) {
    citations.push({ kind: "source-id", value: match[1] });
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    const raw = match[0].replace(/[.,;:!?]+$/, "");
    try { citations.push({ kind: "url", value: canonicalUrl(raw) }); } catch {}
  }
  return [...new Map(citations.map((item) => [`${item.kind}:${item.value}`, item])).values()];
}

function validateCitations(directory, text, requireCitations) {
  const sources = readSourceLedger(directory);
  const allowedIds = new Set(sources.map((source) => source.sourceId));
  const allowedUrls = new Set(sources.map((source) => source.url));
  const citations = citationsFrom(text);
  const ungrounded = citations.filter((citation) => citation.kind === "source-id"
    ? !allowedIds.has(citation.value)
    : !allowedUrls.has(citation.value));
  const valid = ungrounded.length === 0 && (!requireCitations || citations.length > 0);
  appendEvent(directory, {
    type: "research.citation_validation",
    documentHash: sha256(text),
    citationCount: citations.length,
    ungroundedCount: ungrounded.length,
    required: requireCitations,
    valid,
  });
  return { schema: "myclaude.citation-validation/v1", valid, citations, ungrounded, sourceCount: sources.length };
}

async function main() {
  const { command, values, flags } = parseArguments(process.argv.slice(2));
  if (!command || ["help", "--help", "-h"].includes(command)) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const directory = ledgerDirectory(values.ledger);
  if (command === "search" || command === "fetch") {
    const request = command === "search" ? { query: values.query } : { url: values.url };
    if (!Object.values(request)[0]) throw new Error(`${command} requires --${command === "search" ? "query" : "url"}`);
    if (command === "fetch") request.url = canonicalUrl(request.url);
    const response = await callProvider(command, request, values);
    const sources = recordSources(directory, command, request, response);
    process.stdout.write(`${JSON.stringify({
      schema: "myclaude.research-result/v1",
      provider: response.provider,
      answer: redactText(response.answer, 8_000),
      sources,
      ledger: directory,
    }, null, 2)}\n`);
    return;
  }
  if (command === "validate") {
    if (!values.input && values.text === undefined) throw new Error("validate requires --input or --text");
    const text = values.input ? fs.readFileSync(path.resolve(values.input), "utf8") : values.text;
    const result = validateCitations(directory, text, flags.has("require-citations"));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.valid) process.exitCode = 1;
    return;
  }
  if (command === "list") {
    process.stdout.write(`${JSON.stringify({ schema: "myclaude.source-ledger/v1", sources: readSourceLedger(directory) }, null, 2)}\n`);
    return;
  }
  if (command === "verify") {
    const result = verifyLedger(path.join(directory, "evidence.jsonl"));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.valid) process.exitCode = 1;
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`myclaude-research: ${redactText(error.message, 500)}\n`);
  process.exitCode = 2;
});
