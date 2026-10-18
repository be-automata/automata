// Run: node --experimental-strip-types --no-warnings run.ts  -> console summary, results.json, events.jsonl, queue.html
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { replay } from "./heal.ts";

const HERE = import.meta.dirname;
const { steps, baseClaims } = replay();
writeFileSync(join(HERE, "results.json"), JSON.stringify({ baseClaims, steps }, null, 2));
writeFileSync(join(HERE, "events.jsonl"), steps.map((s) => JSON.stringify({ at: new Date().toISOString(), cat: "merge", sha: s.sha, pr: s.pr, flagged: s.flagged, oracle: s.oracleTouched, fp: s.falsePositives.length, fn: s.falseNegatives.length, llm: s.llmCalls, ops: s.ops.map((o) => o.id), drift: s.driftAfterApprove })).join("\n") + "\n");
console.log(`base claims: ${baseClaims}`);
for (const s of steps) {
  const kinds = s.ops.reduce<Record<string, number>>((m, o) => ({ ...m, [o.op]: (m[o.op] ?? 0) + 1 }), {});
  console.log(`${s.sha} #${s.pr ?? "-"} ${s.subject.slice(0, 50).padEnd(50)} flagged=${s.flagged} oracle=${s.oracleTouched} FP=${s.falsePositives.length} ambiguous=${s.ambiguous.length} FN=${s.falseNegatives.length} llm=${s.llmCalls} ops=${JSON.stringify(kinds)} driftAfter=${s.driftAfterApprove}`);
  if (s.falsePositives.length || s.falseNegatives.length) console.log(`   FP ${s.falsePositives.join(",")}  FN ${s.falseNegatives.join(",")}`);
}
const bad = steps.some((s) => s.falsePositives.length || s.falseNegatives.length || s.driftAfterApprove);
console.log(bad ? "\nFAIL: oracle mismatch or residual drift" : "\nPASS: flags == git-diff oracle on every merge; zero drift after approval");

// ---- approval queue page (outside GitHub) ----
const items = steps.flatMap((s) => s.ops.filter((o) => !o.auto).map((o) => ({ ...o, pr: s.pr, subject: s.subject })));
const autoCount = steps.reduce((n, s) => n + s.ops.filter((o) => o.auto).length, 0);
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Knowledge approval queue</title>
<style>:root{--bg:#f7f7f4;--fg:#1a1a17;--mut:#6c6b63;--card:#fff;--line:#e3e2da;--ok:#1f7a3a;--no:#b3261e;--warn:#a96500}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#131311;--fg:#ecebe3;--mut:#9b9a90;--card:#1c1c19;--line:#2e2d29;--ok:#5fc27a;--no:#ff7a70;--warn:#f0a43a}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,sans-serif}.w{max-width:900px;margin:0 auto;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:12px 0;overflow-wrap:anywhere}.mut{color:var(--mut);font-size:12px}
pre{white-space:pre-wrap;font:12px/1.45 ui-monospace,monospace;margin:6px 0}.del{color:var(--no)}.add{color:var(--ok)}
button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:6px;padding:4px 12px;cursor:pointer;margin-right:6px}
.st{font-weight:600}.approved{color:var(--ok)}.rejected{color:var(--no)}.pending{color:var(--warn)}</style></head><body><div class="w">
<h1 style="font-size:18px">Knowledge approval queue: Pilot ops FAQ</h1>
<p class="mut">Replayed ${steps.length} real merges of <code>deploy/PILOT-RUNBOOK.md</code> against ${baseClaims} grounded claims. ${autoCount} content-identical repins were applied automatically. The ${items.length} items below change what the FAQ says, so a person must decide each one. Total model calls: ${steps.reduce((n, s) => n + s.llmCalls, 0)}.</p>
<div id="q"></div><button id="exp">Export decisions (JSON)</button> <span id="sum" class="mut"></span></div>
<script>const ITEMS=${JSON.stringify(items)};const D={};const esc=t=>String(t??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
function draw(){document.getElementById('q').innerHTML=ITEMS.map((o,i)=>'<div class="card"><div class="mut">merge <b>'+o.commit+'</b>'+(o.pr?' · PR #'+o.pr:'')+' · '+esc(o.subject)+'</div><div><b>'+o.op+'</b> '+esc(o.claimId)+(o.score!=null?' · re-anchor confidence '+o.score:'')+' · <span class="st '+(D[o.id]||'pending')+'">'+(D[o.id]||'pending')+'</span></div><div class="mut">'+esc(o.why)+'</div><pre><span class="del">- '+esc(o.before)+'</span>'+(o.after?'\\n<span class="add">+ '+esc(o.after)+'</span>':'')+'</pre><div class="mut">'+o.evidence.map(esc).join('<br>')+'</div><div style="margin-top:8px"><button onclick="dec('+i+',\\'approved\\')">Approve</button><button onclick="dec('+i+',\\'rejected\\')">Reject</button></div></div>').join('');
document.getElementById('sum').textContent=Object.keys(D).length+'/'+ITEMS.length+' decided';}
function dec(i,v){D[ITEMS[i].id]=v;draw();}
document.getElementById('exp').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(ITEMS.map(o=>({id:o.id,commit:o.commit,decision:D[o.id]||'pending',at:new Date().toISOString()})),null,2)],{type:'application/json'}));a.download='knowledge-decisions.json';a.click();};draw();</script></body></html>`;
writeFileSync(join(HERE, "queue.html"), html);
console.log(`queue.html: ${items.length} items for approval, ${autoCount} auto repins`);
process.exit(bad ? 1 : 0);
