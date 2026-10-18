#!/usr/bin/env node
// pre-receive hook. stdin: "<old> <new> <ref>" lines. Claims arrive via GATE_CLAIMS (set by the server after
// token verification). Any violation → exit 1 with reasons on stderr (git relays them as "remote: ...").
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const t0 = performance.now();
const ZERO = /^0+$/;
const claims = JSON.parse(process.env.GATE_CLAIMS ?? "null");
const SCANNER = process.env.GATE_SCANNER ?? "regex"; // regex | gitleaks
const git = (args, input) => execFileSync("git", args, { encoding: "utf8", input, maxBuffer: 1 << 26 });

const SECRET_PATTERNS = [
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
];
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function globToRe(g) {
  return new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*") + "$");
}

function scanSecrets(range) {
  // Every new commit, not the net diff: a secret added then removed inside one push still lands in history
  // (and would be projected to GitHub). One `git log -p` process covers all commits.
  const diff = git(["log", "-p", "--unified=0", "--no-color", "--format=", `${range[0]}..${range[1]}`]);
  const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).join("\n");
  if (SCANNER === "gitleaks") {
    try {
      execFileSync("gitleaks", ["stdin", "--no-banner", "--redact", "--exit-code", "1", "-l", "error"], { input: added, encoding: "utf8" });
      return [];
    } catch (e) {
      return e.status === 1 ? ["gitleaks: secret detected in added lines"] : [`gitleaks failed: ${String(e).slice(0, 80)}`];
    }
  }
  return SECRET_PATTERNS.filter(([, re]) => re.test(added)).map(([name]) => `secret detected: ${name}`);
}

// OpenGAP manifest validation for any agent.yaml touched in the push (minimal YAML subset: top-level scalars).
function checkManifest(newSha, files) {
  const out = [];
  for (const f of files.filter((p) => p === "agent.yaml" || p.endsWith("/agent.yaml"))) {
    let text;
    try { text = git(["show", `${newSha}:${f}`]); } catch { continue; } // deleted
    const fields = Object.fromEntries(text.split("\n").map((l) => l.match(/^([a-z_]+):\s*(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]));
    for (const k of ["name", "version", "description"]) if (!fields[k]) out.push(`${f}: missing required field "${k}"`);
    if (fields.version && !SEMVER.test(fields.version)) out.push(`${f}: version "${fields.version}" is not semver`);
    const dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/") + 1) : "";
    try { git(["cat-file", "-e", `${newSha}:${dir}SOUL.md`]); } catch { out.push(`${f}: OpenGAP requires ${dir}SOUL.md alongside agent.yaml`); }
  }
  return out;
}

const reasons = [];
const accepted = []; // provenance: every commit this push introduces
const stdin = readFileSync(0, "utf8").trim().split("\n").filter(Boolean);
if (!claims) reasons.push("no verified push credential");
for (const line of claims ? stdin : []) {
  const [oldSha, newSha, ref] = line.split(" ");
  if (!ref.startsWith(claims.refPrefix)) { reasons.push(`${ref}: outside this run's ref scope (${claims.refPrefix}*)`); continue; }
  if (ZERO.test(newSha)) { reasons.push(`${ref}: agents may not delete refs`); continue; }
  if (!ZERO.test(oldSha)) {
    try { git(["merge-base", "--is-ancestor", oldSha, newSha]); } catch {
      // Usually the forge moved the branch (reconciled a human change). Tell the agent exactly how to recover.
      const branch = ref.replace("refs/heads/", "");
      reasons.push(`${ref}: non-fast-forward refused — the forge tip moved (${oldSha.slice(0, 12)}). Recover with: git fetch origin && git rebase origin/${branch} && git push origin HEAD:${branch}`);
      continue;
    }
  }
  // Range: new commits only. For a new ref, diff against its merge-base with main.
  const base = ZERO.test(oldSha) ? git(["merge-base", newSha, "refs/heads/main"]).trim() : oldSha;
  const range = [base, newSha];
  const files = git(["diff", "--name-only", ...range]).split("\n").filter(Boolean);
  const res = claims.paths.map(globToRe);
  for (const f of files) if (!res.some((re) => re.test(f))) reasons.push(`${f}: outside allowed paths [${claims.paths.join(", ")}]`);
  reasons.push(...scanSecrets(range).map((r) => `${ref}: ${r}`));
  reasons.push(...checkManifest(newSha, files));
  accepted.push(...git(["rev-list", `${range[0]}..${range[1]}`]).split("\n").filter(Boolean));
}

const ms = +(performance.now() - t0).toFixed(1);
if (process.env.GATE_AUDIT) {
  appendFileSync(process.env.GATE_AUDIT, JSON.stringify({ ts: new Date().toISOString(), category: "gate", event: reasons.length ? "rejected" : "accepted",
    runId: claims?.runId ?? null, refs: stdin.map((l) => l.split(" ")[2]), reasons, gateMs: ms, scanner: SCANNER,
    commits: reasons.length ? [] : accepted }) + "\n");
}
if (reasons.length) {
  process.stderr.write(`\nAGENT FORGE: push rejected (${ms} ms)\n${reasons.map((r) => `  - ${r}`).join("\n")}\n\n`);
  process.exit(1);
}
process.stderr.write(`AGENT FORGE: push accepted (${ms} ms, run ${claims.runId})\n`);
