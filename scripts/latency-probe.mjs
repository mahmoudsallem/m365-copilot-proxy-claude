#!/usr/bin/env node
// E-T1 latency baseline probe (W-D): measures time-to-first-token and total
// turn time against a RUNNING proxy, per model, using the streaming endpoint.
//
//   node scripts/latency-probe.mjs [--proxy URL] [--key KEY]
//        [--models claude-opus,gpt-5.5] [--runs 3] [--gap-ms 20000] [--out FILE]
//
// Sequential by design (thread-rate throttle). Writes a JSON summary line per
// run: {model, run, ttftMs, totalMs, chars}. No auth beyond the proxy key.
import fs from "node:fs";

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const PROXY = arg("proxy", process.env.M365_PROXY_URL ?? `http://127.0.0.1:${process.env.PORT ?? 4141}`);
const KEY = arg("key", process.env.M365_PROXY_API_KEY ?? "m365");
const MODELS = (arg("models", "claude-opus,gpt-5.5")).split(",").map((s) => s.trim());
const RUNS = Number(arg("runs", "3"));
const GAP = Number(arg("gap-ms", "20000"));
const OUT = arg("out", null);
const PROMPT = "Reply with exactly one short sentence about the weather.";

if (!fs.existsSync("scripts")) { console.error("Run from repo root."); process.exit(2); }

async function one(model) {
  const t0 = Date.now();
  let ttft = null, chars = 0;
  const res = await fetch(`${PROXY}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model, max_tokens: 128, stream: true, messages: [{ role: "user", content: PROMPT }] }),
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    return { model, error: `http_${res.status}`, detail: body.slice(0, 140) };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (const chunk of buf.split("\n\n").slice(0, -1)) {
      if (!chunk.startsWith("data: ") || chunk.includes(": keepalive")) continue;
      try {
        const evt = JSON.parse(chunk.slice(6));
        const d = evt.choices?.[0]?.delta?.content;
        if (d && ttft === null) ttft = Date.now() - t0;
        if (d) chars += d.length;
      } catch {}
    }
    buf = buf.slice(buf.lastIndexOf("\n\n") + 2);
    if (ttft === null && chars === 0 && Date.now() - t0 > 180_000) break;
  }
  return { model, ttftMs: ttft, totalMs: Date.now() - t0, chars };
}

const rows = [];
for (const model of MODELS) {
  for (let i = 1; i <= RUNS; i++) {
    const r = await one(model);
    rows.push({ ...r, run: i });
    console.log(JSON.stringify(r));
    if (!(i === RUNS && model === MODELS.at(-1))) await new Promise((r2) => setTimeout(r2, GAP));
  }
}
const ok = rows.filter((r) => r.totalMs);
for (const model of new Set(ok.map((r) => r.model))) {
  const rs = ok.filter((r) => r.model === model);
  const med = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
  console.error(`[latency] ${model}: median ttft=${med(rs.map((r) => r.ttftMs ?? 0))}ms, median total=${med(rs.map((r) => r.totalMs))}ms, n=${rs.length}`);
}
if (OUT) fs.writeFileSync(OUT, JSON.stringify(rows, null, 2));
