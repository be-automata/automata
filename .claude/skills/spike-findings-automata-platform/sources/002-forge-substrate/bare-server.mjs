// Spike 002b — minimal forge: git smart-HTTP via `git http-backend` (CGI) + a server-side merge API.
// POST /api/merge {repo, branch} → merge-tree --write-tree onto main, commit-tree, update-ref CAS, retry on race.
import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const run = promisify(execFile);
const ROOT = process.env.FORGE_ROOT;
const PORT = Number(process.env.PORT ?? 3301);
const GITC = ["-c", "commit.gpgsign=false", "-c", "user.name=forge", "-c", "user.email=forge@forge.local"];
const stats = { merges: 0, casRetries: 0, conflicts: 0 };

async function g(repo, args) {
  const { stdout } = await run("git", ["-C", join(ROOT, repo), ...GITC, ...args], { maxBuffer: 1 << 26 });
  return stdout.trim();
}

// MERGE_LOCK=1: serialize the merge critical section per repo in-process (no queue service, no clone).
const locks = new Map();
async function withRepoLock(repo, fn) {
  const prev = locks.get(repo) ?? Promise.resolve();
  let release;
  const next = new Promise((r) => (release = r));
  locks.set(repo, prev.then(() => next));
  await prev;
  try { return await fn(); } finally { release(); }
}

export async function serverMerge(repo, branch, maxRetries = 50) {
  if (process.env.MERGE_LOCK === "1") return withRepoLock(repo, () => serverMergeOnce(repo, branch, maxRetries));
  return serverMergeOnce(repo, branch, maxRetries);
}

async function serverMergeOnce(repo, branch, maxRetries) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const base = await g(repo, ["rev-parse", "refs/heads/main"]);
    const head = await g(repo, ["rev-parse", `refs/heads/${branch}`]);
    let tree;
    try {
      tree = (await g(repo, ["merge-tree", "--write-tree", "--name-only", base, head])).split("\n")[0];
    } catch (err) {
      // exit 1 = conflicts; stdout lists the tree OID then conflicted paths.
      stats.conflicts++;
      const out = String(err?.stdout ?? "").split("\n");
      return { status: "conflict", base, head, files: out.slice(1).filter((l) => l && !l.startsWith(" ")) };
    }
    const commit = await g(repo, ["commit-tree", tree, "-p", base, "-p", head, "-m", `merge ${branch}`]);
    try {
      await g(repo, ["update-ref", "refs/heads/main", commit, base]); // CAS
      stats.merges++;
      return { status: "merged", commit, attempts: attempt + 1 };
    } catch {
      stats.casRetries++; // main moved; recompute on the new base
    }
  }
  return { status: "gave-up" };
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/merge" && req.method === "POST") {
    let body = "";
    for await (const c of req) body += c;
    const { repo, branch } = JSON.parse(body);
    const out = await serverMerge(repo, branch).catch((e) => ({ status: "error", error: String(e).slice(0, 300) }));
    res.writeHead(out.status === "merged" ? 200 : 409, { "content-type": "application/json" });
    return res.end(JSON.stringify(out));
  }
  if (url.pathname === "/api/stats") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(stats));
  }
  // Everything else → git http-backend (CGI).
  const env = {
    ...process.env, GIT_PROJECT_ROOT: ROOT, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: url.pathname,
    QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers["content-type"] ?? "",
    REMOTE_USER: "agent", REMOTE_ADDR: "127.0.0.1", GIT_HTTP_MAX_REQUEST_BUFFER: "100M",
  };
  if (req.headers["content-encoding"]) env.HTTP_CONTENT_ENCODING = req.headers["content-encoding"];
  if (req.headers["git-protocol"]) env.GIT_PROTOCOL = req.headers["git-protocol"];
  const cgi = spawn("git", ["http-backend"], { env });
  req.pipe(cgi.stdin);
  let head = Buffer.alloc(0), headersDone = false;
  cgi.stdout.on("data", (chunk) => {
    if (headersDone) return res.write(chunk);
    head = Buffer.concat([head, chunk]);
    const idx = head.indexOf("\r\n\r\n");
    if (idx < 0) return;
    headersDone = true;
    let status = 200;
    for (const line of head.subarray(0, idx).toString().split("\r\n")) {
      const [k, ...v] = line.split(":");
      if (k.toLowerCase() === "status") status = parseInt(v.join(":"), 10);
      else res.setHeader(k, v.join(":").trim());
    }
    res.writeHead(status);
    res.write(head.subarray(idx + 4));
  });
  cgi.stdout.on("end", () => res.end());
  cgi.stderr.on("data", (d) => process.stderr.write(d));
}).listen(PORT, () => console.log(`bare forge on :${PORT} root=${ROOT}`));
