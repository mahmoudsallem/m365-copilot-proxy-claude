#!/usr/bin/env node
// Sequentially probe every canonical model through a RUNNING proxy and print a
// scorecard. This validates the full stack per model: registry resolution ->
// tone selection -> M365 turn -> response translation.
//
//   node scripts/validate-models.mjs [--proxy URL] [--key KEY]
//                                    [--models claude-sonnet,gpt-5.5]
//                                    [--cooldown-ms 15000] [--yes]
//
// Quota-aware by design: strictly SEQUENTIAL, one fresh conversation per model,
// generous cooldown between probes (--cooldown-ms, default 15000). Requires
// --yes so it can never burn quota from an accidental loop.
import fs from "node:fs";

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}
const PROXY = arg("proxy", process.env.M365_PROXY_URL ?? `http://127.0.0.1:${process.env.PORT ?? 4141}`);
const KEY = arg("key", process.env.M365_PROXY_API_KEY ?? "");
const ONLY = arg("models", null);
const COOLDOWN = Number(arg("cooldown-ms", "15000"));
const YES = args.includes("--yes");
const OUT = arg("out", "scripts/validate-models-out");

if (!YES) {
  console.error("This sends one REAL message per model (quota!). Re-run with --yes to proceed.");
  process.exit(2);
}

const health = await fetch(`${PROXY}/health`).then((r) => r.json()).catch(() => null);
if (!health?.status) {
  console.error(`[validate] no proxy answering at ${PROXY}`);
  process.exit(1);
}
if (health.fakeMode) {
  console.error("[validate] refusing: proxy is in M365_FAKE_MODE — results would be meaningless.");
  process.exit(2);
}

const modelsPayload = await (await fetch(`${PROXY}/v1/models`)).json();
const canonical = modelsPayload.data.filter((m) => m.m365 && !m.m365.isAlias).map((m) => m.id);
const targets = ONLY ? ONLY.split(",").map((s) => s.trim()) : canonical;

console.log(`[validate] probing ${targets.length} models sequentially (cooldown ${COOLDOWN}ms): ${targets.join(", ")}`);

const rows = [];
for (let i = 0; i < targets.length; i++) {
  const model = targets[i];
  const t0 = Date.now();
  let outcome = "ok";
  let detail = "";
  try {
    const res = await fetch(`${PROXY}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) },
      body: JSON.stringify({
        model,
        max_tokens: 128,
        messages: [{ role: "user", content: `Reply with exactly: ${model} online` }],
      }),
    });
    const ms = Date.now() - t0;
    if (res.status !== 200) {
      const errBody = await res.json().catch(() => ({}));
      outcome = res.status === 429 ? "rate_limited" : res.status === 502 ? (errBody?.error?.type === "disengaged" ? "disengaged" : "empty") : `http_${res.status}`;
      detail = errBody?.error?.message?.slice(0, 120) ?? "";
    } else {
      const body = await res.json();
      const text = body.content?.map((c) => c.text ?? "").join("").trim();
      detail = `${ms}ms · ${(text ?? "").slice(0, 60).replace(/\n/g, " ")}`;
      if (!text) outcome = "empty_payload";
    }
  } catch (e) {
    outcome = "network_error";
    detail = e.message;
  }
  rows.push({ model, outcome, detail });
  console.log(`  [${i + 1}/${targets.length}] ${model.padEnd(30)} ${outcome === "ok" ? "\x1b[32m" : "\x1b[31m"}${outcome}\x1b[0m  ${detail}`);

  // Never fire two fresh conversations back-to-back (F13 thread-rate throttle).
  if (i < targets.length - 1 && COOLDOWN > 0) await new Promise((r) => setTimeout(r, COOLDOWN));
}

fs.mkdirSync(OUT, { recursive: true });
const file = path.join(OUT, `scorecard-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(file, JSON.stringify(rows, null, 2));

const ok = rows.filter((r) => r.outcome === "ok").length;
console.log(`\n[validate] ${ok}/${rows.length} models answered. scorecard -> ${file}`);
