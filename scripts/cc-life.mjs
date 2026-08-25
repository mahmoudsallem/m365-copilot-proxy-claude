// cc-life - replay your Claude Code activity from local transcripts. No AI, no network.
// Usage: node scripts/cc-life.mjs [--days 21] [--recent 25] [--top 12] [--color] [--json]

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const args = process.argv.slice(2);
const opt = {
  days: num(args, '--days', 21),
  recent: num(args, '--recent', 25),
  top: num(args, '--top', 12),
  color: args.includes('--color'),
  json: args.includes('--json'),
};
const W = 64;
const useColor = opt.color || process.stdout.isTTY;
const C = useColor
  ? { c: s => `\x1b[36m${s}\x1b[0m`, g: s => `\x1b[32m${s}\x1b[0m`, y: s => `\x1b[33m${s}`, d: s => `\x1b[90m${s}`, w: s => `\x1b[97m${s}`, r: s => `\x1b[31m${s}` }
  : { c: s => s, g: s => s, y: s => s, d: s => s, w: s => s, r: s => s };

const root = path.join(process.env.USERPROFILE || process.env.HOME, '.claude', 'projects');
if (!fs.existsSync(root)) { console.error('no transcripts dir:', root); process.exit(1); }

const agg = {
  sessions: 0, bytes: 0, prompts: 0, toolCalls: 0,
  firstTs: null, lastTs: null,
  tools: new Map(), commands: new Map(), files: new Map(),
  projects: new Map(), days: new Map(), hours: new Array(24).fill(0),
  recent: [],
};

const t0 = Date.now();
for (const proj of fs.readdirSync(root)) {
  const pdir = path.join(root, proj);
  let st; try { st = fs.statSync(pdir); } catch { continue; }
  if (!st.isDirectory()) continue;
  agg.projects.set(proj, (agg.projects.get(proj) || 0));
  let files = [];
  try { files = fs.readdirSync(pdir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
  for (const f of files) {
    agg.sessions++;
    await scanFile(path.join(pdir, f), proj);
  }
}
agg.recent.sort((a, b) => b.t - a.t);
agg.recent = agg.recent.slice(0, Math.max(opt.recent, 60));

async function scanFile(fp, proj) {
  let size = 0; try { size = fs.statSync(fp).size; } catch { return; }
  agg.bytes += size;
  const rl = readline.createInterface({ input: fs.createReadStream(fp, 'utf8'), crlfDelay: Infinity });
  for await (let line of rl) {
    if (!line || line.length > 2_000_000) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const ts = j.timestamp ? Date.parse(j.timestamp) : NaN;
    if (!Number.isNaN(ts)) {
      if (!agg.firstTs || ts < agg.firstTs) agg.firstTs = ts;
      if (!agg.lastTs || ts > agg.lastTs) agg.lastTs = ts;
    }
    if (j.type === 'user') {
      const c = j.message && j.message.content;
      const isToolResult = Array.isArray(c) && c.some(b => b.type === 'tool_result');
      if (!isToolResult) { agg.prompts++; countAction(ts, proj); }
    } else if (j.type === 'assistant') {
      const c = j.message && j.message.content;
      if (!Array.isArray(c)) continue;
      for (const b of c) {
        if (b.type !== 'tool_use') continue;
        agg.toolCalls++; countAction(ts, proj);
        agg.tools.set(b.name, (agg.tools.get(b.name) || 0) + 1);
        const inp = b.input || {};
        if (b.name === 'Bash' && typeof inp.command === 'string') {
          const k = normCmd(inp.command);
          agg.commands.set(k, (agg.commands.get(k) || 0) + 1);
        }
        if (['Read', 'Write', 'Edit'].includes(b.name)) {
          const fp2 = typeof inp.file_path === 'string' ? inp.file_path : null;
          if (fp2) agg.files.set(fp2, (agg.files.get(fp2) || 0) + 1);
        }
        pushRecent(ts, proj, b.name, inp);
      }
    }
  }
}

function countAction(ts, proj) {
  agg.projects.set(proj, (agg.projects.get(proj) || 0) + 1);
  if (Number.isNaN(ts)) return;
  const d = new Date(ts);
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  agg.days.set(key, (agg.days.get(key) || 0) + 1);
  agg.hours[d.getHours()]++;
}

function pushRecent(ts, proj, name, inp) {
  let detail = '';
  if (name === 'Bash') detail = String(inp.command || '').replace(/\s+/g, ' ').slice(0, 58);
  else if (inp.file_path) detail = shortenPath(String(inp.file_path), 58);
  else if (inp.url) detail = String(inp.url).slice(0, 58);
  else if (inp.query) detail = String(inp.query).slice(0, 58);
  else if (inp.pattern) detail = String(inp.pattern).slice(0, 58);
  else if (inp.description) detail = String(inp.description).slice(0, 58);
  agg.recent.push({ t: Number.isNaN(ts) ? 0 : ts, proj: prettyProj(proj), name, detail });
}

function normCmd(cmd) {
  const c = cmd.replace(/\s+/g, ' ').trim();
  if (!c) return '(empty)';
  const parts = c.split(' ');
  let t = parts[0];
  if (/^(cd|sudo|cmd\.exe|powershell(\.exe)?|pwsh|node|npm|pnpm|npx|bun|git|python3?|pip|uv|cargo|go|make|docker)$/i.test(t) && parts[1]) {
    t += ' ' + parts[1].replace(/["']/g, '');
  }
  t = t.slice(0, 44);
  return t;
}

function shortenPath(p, max) {
  const base = path.basename(p);
  const dir = path.basename(path.dirname(p));
  const s = `${dir}/${base}`.replace(/^\\/, '');
  return s.length > max ? s.slice(-max) : s;
}

function prettyProj(slug) {
  const m = slug.match(/^([A-Za-z])--(.+)$/);
  return m ? `${m[1]}:\\${m[2]}` : slug;
}

function num(a, k, d) { const i = a.indexOf(k); return i >= 0 && a[i + 1] ? parseInt(a[i + 1], 10) || d : d; }

function bar(v, max, width) {
  const n = max > 0 ? Math.max(v > 0 ? 1 : 0, Math.round((v / max) * width)) : 0;
  return '|'.repeat(Math.min(n, width));
}
function fmtN(n) { return n.toLocaleString('en-US'); }

if (opt.json) {
  const top = m => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ k, v }));
  console.log(JSON.stringify({
    sessions: agg.sessions, bytes: agg.bytes, prompts: agg.prompts, toolCalls: agg.toolCalls,
    firstTs: agg.firstTs, lastTs: agg.lastTs, ms: Date.now() - t0,
    projects: top(agg.projects), tools: top(agg.tools), commands: top(agg.commands),
    files: top(agg.files), days: top(agg.days), hours: agg.hours,
    recent: agg.recent.slice(0, opt.recent),
  }, null, 2));
  process.exit(0);
}

// ---------------------------------------------------------------- render
console.log('='.repeat(W));
const now = new Date();
const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
console.log(C.w(` your life in the terminal  |  ${process.env.COMPUTERNAME || 'local'}  |  ${stamp}`));
console.log('='.repeat(W));

const spanDays = agg.firstTs ? Math.max(1, Math.round((agg.lastTs - agg.firstTs) / 86400000)) : 0;
console.log();
console.log(C.c(`-- OVERVIEW ${'-'.repeat(Math.max(2, W - 12))}`));
console.log(`   sessions ${C.g(fmtN(agg.sessions))}   projects ${C.g(fmtN([...agg.projects.keys()].length))}   active span ${C.g(spanDays + 'd')}`);
console.log(`   prompts  ${C.g(fmtN(agg.prompts))}   tool calls ${C.g(fmtN(agg.toolCalls))}   scanned ${(agg.bytes / 1048576).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

console.log();
console.log(C.c(`-- ACTIVITY / DAY (last ${opt.days}d) ${'-'.repeat(Math.max(2, W - 26))}`));
{
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const rows = [];
  for (let i = opt.days - 1; i >= 0; i--) {
    const dt = new Date(today.getTime() - i * 86400000);
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    rows.push([key.slice(5), agg.days.get(key) || 0]);
  }
  const max = Math.max(1, ...rows.map(r => r[1]));
  for (const [k, v] of rows) {
    const b = v === 0 ? C.d('.') : C.c(bar(v, max, 34));
    console.log(`   ${C.d(k)}  ${b} ${v > 0 ? C.w(String(v)) : C.d('-')}`);
  }
}

console.log();
console.log(C.c('-- CLOCK (hour of day, local) ' + '-'.repeat(Math.max(2, W - 31))));
{
  const max = Math.max(1, ...agg.hours);
  for (let h = 0; h < 24; h += 4) {
    const cells = [];
    for (let j = h; j < h + 4; j++) cells.push(`${C.d(String(j).padStart(2, '0'))}${C.c(bar(agg.hours[j], max, 8))}`);
    console.log('   ' + cells.join('  '));
  }
}

const section = (title) => console.log('\n' + C.c(`-- ${title.toUpperCase()} ${'-'.repeat(Math.max(2, W - title.length - 4))}`));
const listTop = (m, label) => {
  const rows = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, opt.top);
  const max = Math.max(1, ...(rows.map(r => r[1])));
  if (!rows.length) { console.log(C.d('   none')); return; }
  for (const [k, v] of rows) console.log(`   ${label(k).padEnd(46)} ${C.c(bar(v, max, 12))} ${C.w(String(v))}`);
};

section('tools');
listTop(agg.tools, k => k);

section('top commands');
listTop(agg.commands, k => k);

section('most-touched files');
listTop(agg.files, k => shortenPath(k, 46));

section('projects');
listTop(agg.projects, k => prettyProj(k).slice(0, 46));

section(`recent actions (last ${Math.min(opt.recent, agg.recent.length)})`);
for (const r of agg.recent.slice(0, opt.recent)) {
  const t = r.t ? new Date(r.t) : null;
  const stamp = t ? `${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}` : '??-?? ??:??';
  const projTag = r.proj.split('\\').pop().slice(0, 18);
  console.log(`   ${C.d(stamp)}  ${C.y(projTag.padEnd(18))} ${C.g(r.name.padEnd(10))} ${r.detail}`);
}

console.log('\n' + '='.repeat(W));
console.log(C.g(` VERDICT: ${fmtN(agg.toolCalls)} actions replayed across ${fmtN(agg.sessions)} sessions.`));
console.log('='.repeat(W));
