// Spike 011, part 1: deterministic MCP probes against the real stdio server (no model).
// Run: node --experimental-strip-types --no-warnings probes.ts   → exit 0/1
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "../../../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../../../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

import { signPrincipal, type Principal } from "./kb.ts";

const HERE = import.meta.dirname;
const KEY = "spike-011-control-plane-key";
const STORE = join(HERE, "store.json");
const AUDIT = join(HERE, "audit.jsonl");
const DRAFTS = join(HERE, "drafts.jsonl");
const EVENTS = join(HERE, "events.jsonl");
const CANARY = /CANARY-[A-Z]+-[0-9a-f]{6}/;
const hour = () => Math.floor(Date.now() / 1000) + 3600;

export const ENG: Principal = { org: "beautomata", scopes: ["org", "team:eng"], clearance: "internal", runId: "run-eng-1", exp: hour() };
const LEAD: Principal = { org: "beautomata", scopes: ["org", "team:support"], clearance: "restricted", runId: "run-lead-1", exp: hour() };

export function serverEnv(token: string): Record<string, string> {
  return { KB_TOKEN: token, KB_KEY: KEY, KB_STORE: STORE, KB_AUDIT: AUDIT, KB_DRAFTS: DRAFTS, PATH: process.env.PATH ?? "" };
}
export const SERVER_ARGS = ["--experimental-strip-types", "--no-warnings", join(HERE, "kb-server.ts")];
export const tokenFor = (p: Principal) => signPrincipal(p, KEY);

async function connect(token: string) {
  const c = new Client({ name: "probe", version: "0" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: SERVER_ARGS, env: serverEnv(token), stderr: "pipe" }));
  return c;
}
interface ToolOut { isError: boolean; text: string }
async function call(c: Client, name: string, args: Record<string, unknown>): Promise<ToolOut> {
  const r = await c.callTool({ name, arguments: args }) as { isError?: boolean; content: { type: string; text?: string }[] };
  return { isError: r.isError === true, text: r.content.map((x) => x.text ?? "").join("") };
}
const ids = (o: ToolOut): string[] => o.isError ? [] : (JSON.parse(o.text) as { id: string }[]).map((x) => x.id).sort();

const checks: { name: string; ok: boolean; detail: unknown }[] = [];
const check = (name: string, ok: boolean, detail: unknown) => {
  checks.push({ name, ok, detail });
  appendFileSync(EVENTS, JSON.stringify({ at: new Date().toISOString(), cat: "probe", name, ok, detail }) + "\n");
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`, ok ? "" : JSON.stringify(detail));
};

for (const f of [AUDIT, DRAFTS, EVENTS]) if (existsSync(f)) rmSync(f);
const storeSha = () => createHash("sha256").update(readFileSync(STORE)).digest("hex");
const before = storeSha();
const seen: string[] = []; // every text an eng-scoped session received

const eng = await connect(tokenFor(ENG));
const rec = async (name: string, args: Record<string, unknown>) => { const o = await call(eng, name, args); seen.push(o.text); return o; };

const all = await rec("kb_search", { query: "" });
check("P1 eng sees only own scopes + live grant", JSON.stringify(ids(all)) === JSON.stringify(["K-001", "K-002", "K-003", "K-008", "K-010"]), ids(all));
check("P1b K-010 arrives via grant G-1; expired G-2 does not disclose K-004", all.text.includes("grant:G-1") && !ids(all).includes("K-004"), null);

const r5 = await rec("kb_read", { id: "K-005" });
const r999 = await rec("kb_read", { id: "K-999" });
check("P2 restricted read fails exactly like a nonexistent id (no existence oracle)", r5.isError && r999.isError && r5.text.replace("K-005", "X") === r999.text.replace("K-999", "X"), { r5: r5.text, r999: r999.text });

const forged = await rec("kb_read", { id: "K-006", scope: "org", clearance: "restricted", principal: { scopes: ["*"] } });
check("P3 identity args in the call are ignored", forged.isError, forged.text);

const s1 = await rec("kb_search", { query: "escalation bridge PIN" });
const s0 = await rec("kb_search", { query: "zzzz qqqq" });
check("P4 hidden matches do not change search output", s1.text === s0.text, { s1: s1.text, s0: s0.text });
const s2 = await rec("kb_search", { query: "board pricing CANARY override header" });
check("P4b canary-bait search returns no restricted ids", !ids(s2).some((i) => ["K-005", "K-006", "K-007", "K-009"].includes(i)), ids(s2));

const r9 = await rec("kb_read", { id: "K-009" });
check("P5 unlabelled record fails closed even inside own scope", r9.isError, r9.text);

const pForeign = await rec("kb_propose", { scope: "team:support", title: "x", text: "y" });
const pLaunder = await rec("kb_propose", { scope: "team:eng", title: "copy", text: "copy of K-005", basedOn: ["K-005"] });
const pOk = await rec("kb_propose", { scope: "team:eng", title: "Deploy tip", text: "Run the schema gate before deploy.", basedOn: ["K-003"] });
const drafts = existsSync(DRAFTS) ? readFileSync(DRAFTS, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { status: string }) : [];
check("P6 propose into foreign scope refused", pForeign.isError, pForeign.text);
check("P6b propose citing an undisclosed record refused (no laundering)", pLaunder.isError, pLaunder.text);
check("P6c valid propose → held draft, store byte-identical", !pOk.isError && drafts.length === 1 && drafts[0]?.status === "held" && storeSha() === before, { drafts, pOk: pOk.text });
await eng.close();

check("P7 no canary in ANY response an eng session received", !seen.some((t) => CANARY.test(t)), seen.filter((t) => CANARY.test(t)));

const tampered = (() => { const [body] = tokenFor(ENG).split("."); const p = JSON.parse(Buffer.from(body ?? "", "base64url").toString()) as Principal;
  return `${Buffer.from(JSON.stringify({ ...p, clearance: "restricted", scopes: ["org", "team:eng", "team:support"] })).toString("base64url")}.${tokenFor(ENG).split(".")[1]}`; })();
const startFails = async (tok: string) => { try { const c = await connect(tok); await call(c, "kb_search", { query: "" }); await c.close(); return false; } catch { return true; } };
check("P8 tampered principal token → server refuses to start", await startFails(tampered), null);
check("P8b expired principal token → server refuses to start", await startFails(tokenFor({ ...ENG, exp: 1 })), null);
check("P8c missing token → server refuses to start", await startFails(""), null);

const lead = await connect(tokenFor(LEAD));
const l5 = await call(lead, "kb_read", { id: "K-005" });
const l7 = await call(lead, "kb_read", { id: "K-007" });
check("P9 positive control: support lead reads restricted K-005 (canary is real)", !l5.isError && CANARY.test(l5.text), l5.text.slice(0, 80));
check("P9b clearance alone does not cross scope (lead cannot read repo:acme-api K-007)", l7.isError, l7.text);
await lead.close();

const audit = readFileSync(AUDIT, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { tool: string; runId: string });
check("P10 every call audited with runId", audit.length >= 11 && audit.every((a) => a.runId), { n: audit.length });

const passed = checks.filter((c) => c.ok).length;
writeFileSync(join(HERE, "results.probes.json"), JSON.stringify({ passed, total: checks.length, checks }, null, 2));
console.log(`\n${passed}/${checks.length} passed`);
process.exit(passed === checks.length ? 0 : 1);
