// Spike 005 — one forge process: token edge + smart-HTTP + pre-receive gate (003), server-side merge (004),
// GitHub projection (001), plus a provenance check: nothing is projected unless every commit in the range was
// accepted by the gate, created by the forge, or imported from GitHub.
import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { verify, mint } from "./token.mjs";

// Hermetic git for this process and every child (http-backend, receive-pack, the hook).
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const run = promisify(execFile);
const ROOT = process.env.FORGE_ROOT;
const PORT = Number(process.env.PORT ?? 3305);
const AUDIT = process.env.GATE_AUDIT;
const GH_REPO = process.env.SPIKE_GH_REPO ?? "be-automata/astro-web";
const REMOTE = `https://github.com/${GH_REPO}.git`;
const STATE = join(ROOT, "projection-state.json");
const ID = ["-c", "user.name=forge", "-c", "user.email=forge@forge.local", "-c", "commit.gpgsign=false"];
const CRED = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];
const revoked = new Set();

const audit = (category, event, data) =>
  appendFileSync(AUDIT, JSON.stringify({ ts: new Date().toISOString(), category, event, ...data }) + "\n");
const g = async (repo, args) => (await run("git", ["-C", join(ROOT, repo), ...ID, ...args], { maxBuffer: 1 << 26 })).stdout.trim();
const gh = async (args) => { const { stdout } = await run("gh", ["api", ...args]); return stdout ? JSON.parse(stdout) : null; };
const state = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { projected: {}, prs: {} });
const saveState = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2));

const locks = new Map();
async function withLock(key, fn) {
  const prev = locks.get(key) ?? Promise.resolve(); let rel; const next = new Promise((r) => (rel = r));
  locks.set(key, prev.then(() => next)); await prev; try { return await fn(); } finally { rel(); }
}

// Provenance = gate-accepted commits ∪ forge-created commits ∪ commits imported from GitHub.
function knownCommits() {
  const known = new Map();
  for (const line of readFileSync(AUDIT, "utf8").split("\n")) {
    if (!line) continue;
    const e = JSON.parse(line);
    for (const c of e.commits ?? []) known.set(c, `${e.category}/${e.event}`);
  }
  return known;
}

function bearer(req) {
  const h = req.headers.authorization ?? "";
  if (!h.startsWith("Basic ")) return null;
  return Buffer.from(h.slice(6), "base64").toString().split(":")[1] ?? null;
}

// ---- merge (004): merge `branch` into `into`, both inside the caller's ref scope ----
async function merge(repo, branch, into, claims) {
  for (const r of [branch, into]) if (!`refs/heads/${r}`.startsWith(claims.refPrefix)) return { status: "refused", reason: `${r} is outside ${claims.refPrefix}*` };
  return withLock(repo, async () => {
    const base = await g(repo, ["rev-parse", `refs/heads/${into}`]);
    const head = await g(repo, ["rev-parse", `refs/heads/${branch}`]);
    try {
      const tree = (await g(repo, ["merge-tree", "--write-tree", base, head])).split("\n")[0];
      const commit = await g(repo, ["commit-tree", tree, "-p", base, "-p", head, "-m", `forge: merge ${branch} into ${into}`]);
      await g(repo, ["update-ref", `refs/heads/${into}`, commit, base]);
      audit("merge", "merged", { runId: claims.runId, branch, into, commit, commits: [commit] });
      return { status: "merged", commit };
    } catch (err) {
      if (err?.code !== 1) throw err;
      audit("merge", "conflict", { runId: claims.runId, branch, into });
      return { status: "conflict", base, head, conflictTree: String(err.stdout).split("\n")[0] };
    }
  });
}

// ---- projection (001) + provenance gate ----
async function project(repo, branch, runId) {
  const s = state();
  const dst = `spike/forge-${branch.replaceAll("/", "-")}`;
  const sha = await g(repo, ["rev-parse", `refs/heads/${branch}`]);
  const lease = s.projected[dst] ?? "";
  // Provenance: every commit we would publish that GitHub doesn't already have.
  const range = (await g(repo, ["rev-list", sha, "--not", "refs/heads/main", ...(lease ? [lease] : [])])).split("\n").filter(Boolean);
  const known = knownCommits();
  const unknown = range.filter((c) => !known.has(c));
  if (unknown.length) {
    audit("projection", "refused-provenance", { runId, branch: dst, unknown });
    return { status: "refused-provenance", unknown };
  }
  if (lease === sha) {
    audit("projection", "noop", { runId, branch: dst, sha });
  } else {
    try {
      await run("git", ["-C", join(ROOT, repo), ...CRED, "push", "-q", `--force-with-lease=refs/heads/${dst}:${lease}`, REMOTE, `${sha}:refs/heads/${dst}`]);
      s.projected[dst] = sha; saveState(s);
      audit("projection", "pushed", { runId, branch: dst, from: lease || null, to: sha, published: range.length });
    } catch (err) {
      const msg = `${err?.message ?? ""} ${err?.stderr ?? ""}`;
      if (!/stale info|rejected|fetch first|non-fast-forward/.test(msg)) throw err;
      await run("git", ["-C", join(ROOT, repo), ...CRED, "fetch", "-q", REMOTE, `+refs/heads/${dst}:refs/forge/inbound/${branch}`]);
      const theirs = await g(repo, ["rev-parse", `refs/forge/inbound/${branch}`]);
      const imported = (await g(repo, ["rev-list", theirs, "--not", sha, "refs/heads/main"])).split("\n").filter(Boolean);
      // Imported human commits enter provenance as "github/imported" — reviewed where humans work.
      audit("projection", "diverged", { runId, branch: dst, github: theirs, forge: sha, commits: imported });
      return { status: "diverged", theirs, imported };
    }
  }
  await ensurePr(dst, branch, sha, s);
  return { status: "projected", sha, branch: dst };
}

async function ensurePr(dst, branch, sha, s) {
  const owner = GH_REPO.split("/")[0];
  let number = s.prs[dst] ?? (await gh([`repos/${GH_REPO}/pulls?head=${owner}:${dst}&state=open`]))?.[0]?.number;
  const body = `Projected from Agent Forge (spike 005).\n\nforge ref \`${branch}\` @ \`${sha.slice(0, 12)}\` — every commit passed the push gate or was forge-created.`;
  if (number) await gh(["-X", "PATCH", `repos/${GH_REPO}/pulls/${number}`, "-f", `body=${body}`]);
  else {
    try {
      number = (await gh(["-X", "POST", `repos/${GH_REPO}/pulls`, "-f", `title=[spike] forge pipeline ${branch}`, "-f", `head=${dst}`, "-f", "base=main", "-f", `body=${body}`, "-F", "draft=true"])).number;
    } catch (err) {
      if (!/already exists/.test(`${err?.message} ${err?.stdout}`)) throw err;
      number = (await gh([`repos/${GH_REPO}/pulls?head=${owner}:${dst}&state=open`]))?.[0]?.number;
    }
  }
  const fresh = state(); fresh.prs[dst] = number; saveState(fresh);
}

// Reconcile a diverged branch server-side: merge GitHub's tip (inbound) into the forge branch, then the lease
// becomes GitHub's tip so the next projection is a fast-forward.
async function reconcile(repo, branch, runId) {
  return withLock(repo, async () => {
    const s = state();
    const dst = `spike/forge-${branch.replaceAll("/", "-")}`;
    const ours = await g(repo, ["rev-parse", `refs/heads/${branch}`]);
    const theirs = await g(repo, ["rev-parse", `refs/forge/inbound/${branch}`]);
    const tree = (await g(repo, ["merge-tree", "--write-tree", ours, theirs])).split("\n")[0];
    const commit = await g(repo, ["commit-tree", tree, "-p", ours, "-p", theirs, "-m", `forge: reconcile human change on ${dst}`]);
    await g(repo, ["update-ref", `refs/heads/${branch}`, commit, ours]);
    s.projected[dst] = theirs; saveState(s);
    audit("forge", "reconciled", { runId, branch, commit, parents: [ours, theirs], commits: [commit] });
    return { status: "reconciled", commit };
  });
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  try {
    if (url.pathname.startsWith("/api/")) {
      let body = ""; for await (const c of req) body += c;
      const j = JSON.parse(body || "{}");
      if (url.pathname === "/api/mint") return res.end(mint(j)); // production: the credential broker
      if (url.pathname === "/api/revoke") { revoked.add(JSON.parse(Buffer.from(j.token.split(".")[0], "base64url").toString()).jti); return res.end("ok"); }
      const claims = verify(j.token, { repo: j.repo, revoked });
      if (url.pathname === "/api/merge") return json(200, await merge(j.repo, j.branch, j.into, claims));
      if (url.pathname === "/api/project") return json(200, await project(j.repo, j.branch, claims.runId));
      if (url.pathname === "/api/reconcile") return json(200, await reconcile(j.repo, j.branch, claims.runId));
      return json(404, { error: "unknown route" });
    }
  } catch (err) {
    return json(403, { error: err instanceof Error ? err.message : String(err) });
  }
  // git smart-HTTP; pushes need a valid token (edge), content policy runs in pre-receive.
  const repo = url.pathname.split("/")[1];
  const isPush = url.searchParams.get("service") === "git-receive-pack" || url.pathname.endsWith("/git-receive-pack");
  let claims = null;
  if (isPush) {
    const token = bearer(req);
    if (!token) { res.writeHead(401, { "www-authenticate": 'Basic realm="agent-forge"' }); return res.end("push requires a per-run token\n"); }
    try { claims = verify(token, { repo, revoked }); }
    catch (err) { audit("edge", "refused", { repo, reason: String(err.message) }); res.writeHead(403); return res.end(`AGENT FORGE: ${err.message}\n`); }
  }
  const env = { ...process.env, GIT_PROJECT_ROOT: ROOT, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
    REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers["content-type"] ?? "", REMOTE_USER: claims?.runId ?? "anonymous",
    REMOTE_ADDR: "127.0.0.1", GATE_CLAIMS: claims ? JSON.stringify(claims) : "" };
  if (req.headers["content-encoding"]) env.HTTP_CONTENT_ENCODING = req.headers["content-encoding"];
  if (req.headers["git-protocol"]) env.GIT_PROTOCOL = req.headers["git-protocol"];
  const cgi = spawn("git", ["-c", "http.receivepack=true", "http-backend"], { env });
  req.pipe(cgi.stdin);
  let head = Buffer.alloc(0), done = false;
  cgi.stdout.on("data", (chunk) => {
    if (done) return res.write(chunk);
    head = Buffer.concat([head, chunk]);
    const idx = head.indexOf("\r\n\r\n"); if (idx < 0) return;
    done = true; let status = 200;
    for (const line of head.subarray(0, idx).toString().split("\r\n")) {
      const [k, ...v] = line.split(":");
      if (k.toLowerCase() === "status") status = parseInt(v.join(":"), 10); else res.setHeader(k, v.join(":").trim());
    }
    res.writeHead(status); res.write(head.subarray(idx + 4));
  });
  cgi.stdout.on("end", () => res.end());
  cgi.stderr.on("data", (d) => process.stderr.write(d));
}).listen(PORT, () => console.log(`forge on :${PORT}`));
