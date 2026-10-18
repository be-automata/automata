// Spike 007 — bytes the forge serves per agent session, by clone strategy; then $/repo/month.
// node egress.mjs   (binds :3307; local only)
import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, rmSync, writeFileSync, createReadStream, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = join(HERE, "work");
const SRC = process.env.SRC_REPO ?? "/Users/senior/.superset/projects/automata-platform/.git";
const LABEL = process.env.LABEL ?? "automata";
const SPARSE = process.env.SPARSE_DIR ?? "packages/shared";
const BRANCH = process.env.SRC_BRANCH ?? "main";
const PORT = 3307;
const URL_ = `http://localhost:${PORT}/app.git`;
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
const git = (cwd, args) => run("git", args, { cwd, env: ENV, maxBuffer: 1 << 27 }).then((r) => r.stdout.trim());

const bytes = { forge: 0, cdn: 0, requests: 0 };
const reset = () => { bytes.forge = 0; bytes.cdn = 0; bytes.requests = 0; };

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  bytes.requests++;
  if (url.pathname.startsWith("/cdn/")) { // object storage / CDN for bundles (cheap or free egress)
    const f = join(WORK, url.pathname.slice(5));
    res.writeHead(200, { "content-length": statSync(f).size });
    const s = createReadStream(f); s.on("data", (c) => (bytes.cdn += c.length)); return s.pipe(res);
  }
  const env = { ...ENV, GIT_PROJECT_ROOT: WORK, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
    REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers["content-type"] ?? "", REMOTE_ADDR: "127.0.0.1" };
  if (req.headers["content-encoding"]) env.HTTP_CONTENT_ENCODING = req.headers["content-encoding"];
  if (req.headers["git-protocol"]) env.GIT_PROTOCOL = req.headers["git-protocol"];
  const cgi = spawn("git", ["http-backend"], { env });
  req.pipe(cgi.stdin);
  let head = Buffer.alloc(0), done = false;
  cgi.stdout.on("data", (chunk) => {
    if (done) { bytes.forge += chunk.length; return res.write(chunk); }
    head = Buffer.concat([head, chunk]);
    const idx = head.indexOf("\r\n\r\n"); if (idx < 0) return;
    done = true; let status = 200;
    for (const line of head.subarray(0, idx).toString().split("\r\n")) {
      const [k, ...v] = line.split(":");
      if (k.toLowerCase() === "status") status = parseInt(v.join(":"), 10); else res.setHeader(k, v.join(":").trim());
    }
    res.writeHead(status); const body = head.subarray(idx + 4); bytes.forge += body.length; res.write(body);
  });
  cgi.stdout.on("end", () => res.end());
});

async function measure(name, fn) {
  const dir = join(WORK, "clients", name);
  rmSync(dir, { recursive: true, force: true });
  reset();
  const t0 = performance.now();
  const extra = await fn(dir);
  const ms = Math.round(performance.now() - t0);
  // Files actually materialized (ls-files would also count sparse, skip-worktree entries).
  const files = Number(await git(dir, ["ls-files", "-t"]).then((o) => o.split("\n").filter((l) => l.startsWith("H ")).length).catch(() => 0));
  const row = { name, forgeMB: +(bytes.forge / 1e6).toFixed(2), cdnMB: +(bytes.cdn / 1e6).toFixed(2), requests: bytes.requests, ms, filesInWorktree: files, ...extra };
  console.log(JSON.stringify(row));
  return row;
}

async function main() {
  rmSync(WORK, { recursive: true, force: true }); mkdirSync(join(WORK, "clients"), { recursive: true });
  await run("git", ["clone", "-q", "--bare", "--no-local", "--single-branch", "--branch", BRANCH, SRC, join(WORK, "app.git")], { env: ENV });
  if (BRANCH !== "main") await git(join(WORK, "app.git"), ["branch", "-m", BRANCH, "main"]);
  await git(join(WORK, "app.git"), ["symbolic-ref", "HEAD", "refs/heads/main"]);
  const repo = join(WORK, "app.git");
  for (const [k, v] of [["uploadpack.allowFilter", "true"], ["uploadpack.allowAnySHA1InWant", "true"], ["uploadpack.allowReachableSHA1InWant", "true"]]) await git(repo, ["config", k, v]);
  await git(repo, ["repack", "-adq"]); // production would keep repos well-packed
  const head = await git(repo, ["rev-parse", "main"]);
  const commits = Number(await git(repo, ["rev-list", "--count", "main"]));
  const packMB = +(Number((await git(repo, ["count-objects", "-v"])).match(/size-pack: (\d+)/)[1]) / 1024).toFixed(2);
  await new Promise((r) => server.listen(PORT, r));
  const C = (dir, ...a) => git(WORK, ["clone", "-q", ...a, URL_, dir]);
  const rows = [];

  rows.push(await measure("full clone", (d) => C(d)));
  rows.push(await measure("shallow --depth=1", (d) => C(d, "--depth=1")));
  rows.push(await measure("blobless (--filter=blob:none)", (d) => C(d, "--filter=blob:none")));
  rows.push(await measure("blobless + sparse (one package)", async (d) => {
    await C(d, "--filter=blob:none", "--sparse");
    await git(d, ["sparse-checkout", "set", SPARSE]);
  }));

  // bundle-uri: a nightly bundle of main as of N commits ago sits on a CDN; the forge serves only the delta.
  const lag = Math.min(20, commits - 1);
  await git(repo, ["update-ref", "refs/heads/nightly", `main~${lag}`]);
  await git(repo, ["bundle", "create", join(WORK, "nightly.bundle"), "refs/heads/nightly"]);
  await git(repo, ["update-ref", "-d", "refs/heads/nightly"]);
  rows.push(await measure(`bundle-uri (bundle ${lag} commits stale)`, (d) => C(d, `--bundle-uri=http://localhost:${PORT}/cdn/nightly.bundle`)));

  // Warm persistent box (spike 013): already has the repo, fetches the next N commits.
  const warm = join(WORK, "clients", "warm");
  await git(repo, ["update-ref", "refs/heads/main", `${head}~${lag}`]);
  await C(warm);
  await git(repo, ["update-ref", "refs/heads/main", head]);
  rows.push(await measure(`warm box fetch (+${lag} commits)`, async () => { await git(warm, ["fetch", "-q", "origin"]); await git(warm, ["merge", "-q", "--ff-only", "origin/main"]); return { note: "persistent $HOME volume" }; }));
  server.close();

  // ---- economics: $ per busy repo per month ----
  const SESSIONS_PER_DAY = 200; // reference customer: 50 agents × 4 sessions/day on one hot repo
  const PRICES = { "AWS egress ($0.09/GB)": 0.09, "Hetzner overage (~$1.1/TB)": 0.0011, "co-located (same DC, $0)": 0 };
  const econ = rows.map((r) => ({ name: r.name, gbPerMonth: +((r.forgeMB * SESSIONS_PER_DAY * 30) / 1000).toFixed(1),
    cost: Object.fromEntries(Object.entries(PRICES).map(([k, p]) => [k, +((r.forgeMB * SESSIONS_PER_DAY * 30 / 1000) * p).toFixed(2)])) }));
  writeFileSync(join(HERE, `results-${LABEL}.json`), JSON.stringify({ label: LABEL, sparseDir: SPARSE, repo: { commits, files: rows[0].filesInWorktree, packMB, head: head.slice(0, 12) }, sessionsPerDay: SESSIONS_PER_DAY, rows, econ }, null, 2));
  console.table(econ.map((e) => ({ name: e.name, GBmo: e.gbPerMonth, ...e.cost })));
}
main().catch((e) => { console.error(e); server.close(); process.exitCode = 1; });
