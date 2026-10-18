#!/usr/bin/env node
// pre-receive for the KNOWLEDGE repo. Generic rules from spike 003 (ref scope, fast-forward, path scope, secrets
// on every commit) plus knowledge rules:
//   K1 every commit carries Knowledge-Op, Source-Commit and Approved-By trailers;
//   K2 Source-Commit must be reachable from the SOURCE repo's main (provenance cannot be invented);
//   K3 a commit that changes what a page SAYS (pages/*.md or any claim statement) needs a human approver,
//      and every op id must have a matching approved decision in the ledger for that source commit;
//   K4 every claim whose statement changed must be covered by an approved op id;
//   K5 "Approved-By: auto:repin" may only move evidence pins: pages/ untouched, all ops are repin:*;
//   K6 an agent-written page must be exactly the render of its approved claims (no text smuggled beside them).
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const t0 = performance.now();
const ZERO = /^0+$/;
const claims = JSON.parse(process.env.GATE_CLAIMS || "null");
const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 26 });
// The source repo check must NOT inherit this push's GIT_DIR / quarantine object dir.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_") || k === "GIT_CONFIG_GLOBAL" || k === "GIT_CONFIG_NOSYSTEM"));
const sourceHas = (sha) => { try { execFileSync("git", ["-C", process.env.SOURCE_REPO, "merge-base", "--is-ancestor", sha, "refs/heads/main"], { env: cleanEnv, stdio: "ignore" }); return true; } catch { return false; } };
const ledger = () => readFileSync(process.env.LEDGER, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const globToRe = (g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*") + "$");
const SECRETS = [/\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bsk-ant-[A-Za-z0-9_-]{20,}/];
const statements = (sha, path) => { try { return Object.fromEntries(JSON.parse(git(["show", `${sha}:${path}`])).claims.map((c) => [c.id, c.statement])); } catch { return {}; } };

const reasons = [];
const stdin = readFileSync(0, "utf8").trim().split("\n").filter(Boolean);
if (!claims) reasons.push("no verified push credential");
for (const line of claims ? stdin : []) {
  const [oldSha, newSha, ref] = line.split(" ");
  if (!ref.startsWith(claims.refPrefix)) { reasons.push(`${ref}: outside this run's ref scope (${claims.refPrefix}*)`); continue; }
  if (ZERO.test(newSha)) { reasons.push(`${ref}: deleting refs is refused`); continue; }
  if (!ZERO.test(oldSha)) { try { git(["merge-base", "--is-ancestor", oldSha, newSha]); } catch { reasons.push(`${ref}: non-fast-forward refused`); continue; } }
  const commits = git(["rev-list", "--reverse", ZERO.test(oldSha) ? newSha : `${oldSha}..${newSha}`]).split("\n").filter(Boolean);
  const pathRes = claims.paths.map(globToRe);
  const added = git(["log", "-p", "--unified=0", "--no-color", "--format=", ...(ZERO.test(oldSha) ? [newSha] : [`${oldSha}..${newSha}`])]).split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).join("\n");
  if (SECRETS.some((re) => re.test(added))) reasons.push(`${ref}: secret detected in added lines`);
  for (const c of commits) {
    const short = c.slice(0, 8);
    const [opsRaw, src, by] = git(["log", "-1", "--format=%(trailers:key=Knowledge-Op,valueonly,separator=%x2C)%x1f%(trailers:key=Source-Commit,valueonly)%x1f%(trailers:key=Approved-By,valueonly)", c]).split("\x1f").map((s) => s.trim());
    const ops = opsRaw ? opsRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const parent = git(["rev-list", "--parents", "-n", "1", c]).trim().split(" ")[1];
    const files = parent ? git(["diff", "--name-only", parent, c]).split("\n").filter(Boolean) : git(["ls-tree", "-r", "--name-only", c]).split("\n").filter(Boolean);
    for (const f of files) if (!pathRes.some((re) => re.test(f))) reasons.push(`${short} ${f}: outside allowed paths [${claims.paths.join(", ")}]`);
    if (!ops.length || !src || !by) { reasons.push(`${short}: missing provenance trailers (Knowledge-Op, Source-Commit, Approved-By)`); continue; }
    if (!sourceHas(src)) { reasons.push(`${short}: Source-Commit ${src.slice(0, 12)} is not on the source repo's main`); continue; }
    const pageChanged = files.some((f) => f.startsWith("pages/"));
    const changed = new Set();
    const seededFiles = new Set();
    for (const f of files.filter((f) => f.startsWith(".claims/"))) {
      const isNew = !parent || (() => { try { git(["cat-file", "-e", `${parent}:${f}`]); return false; } catch { return true; } })();
      // A brand-new page is approved as a whole by one "seed:<page>" decision.
      if (isNew && ops.includes(`seed:${f.replace(/^\.claims\//, "").replace(/\.json$/, "")}`)) { seededFiles.add(f); continue; }
      const a = parent ? statements(parent, f) : {}, b = statements(c, f);
      for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[id] !== b[id]) changed.add(id);
    }
    for (const f of files.filter((f) => /^pages\/[^/]+\.md$/.test(f))) {
      const slugName = f.slice(6, -3);
      let page = null, sc = null;
      try { page = git(["show", `${c}:${f}`]); sc = JSON.parse(git(["show", `${c}:.claims/${slugName}.json`])); } catch { /* deleted page or missing sidecar */ }
      if (page !== null && (!sc || page !== sc.claims.map((x) => x.statement).join("\n\n") + "\n")) reasons.push(`${short} ${f}: page text is not the render of its claims (text outside any claim)`);
    }
    if (by === "auto:repin") {
      if (pageChanged || changed.size) reasons.push(`${short}: auto:repin may only move evidence pins, but it changes ${pageChanged ? "page text" : "claim statements"}`);
      if (ops.some((o) => !o.startsWith("repin:"))) reasons.push(`${short}: auto:repin lists non-repin ops (${ops.filter((o) => !o.startsWith("repin:")).join(", ")})`);
      continue;
    }
    const decisions = ledger();
    for (const op of ops) if (!decisions.some((d) => d.opId === op && d.sourceCommit === src && d.decision === "approved" && d.by === by)) reasons.push(`${short}: op ${op} has no approved decision by ${by} for ${src.slice(0, 12)}`);
    const covered = new Set(ops.map((o) => o.slice(o.indexOf(":") + 1)));
    for (const id of changed) if (!covered.has(id)) reasons.push(`${short}: claim ${id} changed without an approved op`);
  }
}
const ms = +(performance.now() - t0).toFixed(1);
if (process.env.GATE_AUDIT) appendFileSync(process.env.GATE_AUDIT, JSON.stringify({ at: new Date().toISOString(), cat: "gate", event: reasons.length ? "rejected" : "accepted", runId: claims?.runId ?? null, refs: stdin.map((l) => l.split(" ")[2]), reasons, gateMs: ms }) + "\n");
if (reasons.length) { process.stderr.write(`\nKNOWLEDGE FORGE: push rejected (${ms} ms)\n${reasons.map((r) => `  - ${r}`).join("\n")}\n\n`); process.exit(1); }
process.stderr.write(`KNOWLEDGE FORGE: push accepted (${ms} ms, run ${claims.runId})\n`);
