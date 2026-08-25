const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>m365-copilot-proxy status</title>
<meta http-equiv="refresh" content="5">
<style>
  body{font-family:ui-monospace,Consolas,monospace;background:#0b0e14;color:#d7dce6;margin:24px}
  h1{font-size:18px} h2{font-size:14px;color:#8ab4ff;margin:18px 0 6px}
  table{border-collapse:collapse;font-size:12px}
  td,th{border:1px solid #2a3040;padding:3px 10px;text-align:left}
  th{color:#9aa4b8;font-weight:600}
  .ok{color:#7ee787}.warn{color:#e3b341}.bad{color:#ff7b72}.muted{color:#8b949e}
  small{color:#8b949e}
</style></head><body>
<h1>m365-copilot-proxy <small>· auto-refresh 5s · <a style="color:#8ab4ff" href="/health">/health</a> <a style="color:#8ab4ff" href="/v1/models">/v1/models</a> <a style="color:#8ab4ff" href="/internal/stats">/internal/stats</a></small></h1>
<h2>Tone health (circuit breakers)</h2><div id="tones">…</div>
<h2>Recent upstream turns</h2><div id="turns">…</div>
<script>
async function j(u){return (await fetch(u)).json()}
function esc(s){return String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]))}
(async()=>{
  try{
    const [h,s]=await Promise.all([j("/health"),j("/internal/stats")]);
    const badge=(st)=>st==="closed"?"<span class='ok'>closed</span>":st==="half_open"?"<span class='warn'>half-open</span>":"<span class='bad'>OPEN</span>";
    document.getElementById("tones").innerHTML =
      "<table><tr><th>model</th><th>breaker</th><th>consecutive failures</th></tr>"+
      (s.tones.length?s.tones.map(t=>"<tr><td>"+esc(t.model)+"</td><td>"+badge(t.status)+"</td><td>"+t.consecutiveFailures+"</td></tr>").join(""):"<tr><td colspan='3' class='muted'>no failures recorded — all tones healthy</td></tr>")+"</table>"+
      "<p><small>conversations: "+h.conversations+" · gate: "+JSON.stringify(h.gate)+" · degradedBackoff: "+h.degradedBackoff+"</small></p>";
    const cls=(o)=>o==="ok"?"<span class='ok'>ok</span>":o==="disengaged"?"<span class='warn'>disengaged</span>":o==="rate_limited"?"<span class='warn'>limited</span>":"<span class='bad'>empty</span>";
    document.getElementById("turns").innerHTML =
      "<table><tr><th>when</th><th>model</th><th>total</th><th>ttft</th><th>chars</th><th>outcome</th></tr>"+
      s.turns.slice().reverse().map(t=>"<tr><td class='muted'>"+new Date(t.at).toLocaleTimeString()+"</td><td>"+esc(t.model)+"</td><td>"+t.totalMs+"ms</td><td>"+(t.ttftMs==null?"—":t.ttftMs+"ms")+"</td><td>"+t.chars+"</td><td>"+cls(t.outcome)+"</td></tr>").join("")+"</table>";
  }catch(e){document.body.insertAdjacentHTML("beforeend","<pre class='bad'>"+esc(e.message)+"</pre>")}
})();
</script></body></html>`;

/** Local status dashboard — keep the proxy bound to 127.0.0.1. */
export default defineEventHandler((event) => {
  if (!["127.0.0.1", "localhost"].includes(getRequestIP(event) ?? "")) {
    throw createError({ statusCode: 403, statusMessage: "Local only" });
  }
  return page;
});
