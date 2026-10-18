// Spike 003 — smart-HTTP forge with credential check at the edge and policy in pre-receive.
// Reads are open (spike); every receive-pack request must carry a valid per-run token (Basic password).
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { verify, mint } from "./token.mjs";

const ROOT = process.env.FORGE_ROOT;
const PORT = Number(process.env.PORT ?? 3303);
const AUDIT = process.env.GATE_AUDIT;
const revoked = new Set();

function audit(event, data) {
  if (AUDIT) appendFileSync(AUDIT, JSON.stringify({ ts: new Date().toISOString(), category: "edge", event, ...data }) + "\n");
}

function bearer(req) {
  const h = req.headers.authorization ?? "";
  if (!h.startsWith("Basic ")) return null;
  const [, pass] = Buffer.from(h.slice(6), "base64").toString().split(":");
  return pass ?? null;
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/") && req.method === "POST") {
    let body = "";
    for await (const c of req) body += c;
    const j = JSON.parse(body || "{}");
    if (url.pathname === "/api/mint") return res.end(mint(j)); // in production: the credential broker
    if (url.pathname === "/api/revoke") {
      const [b] = j.token.split(".");
      revoked.add(JSON.parse(Buffer.from(b, "base64url").toString()).jti);
      audit("revoked", { runId: j.runId });
      return res.end("ok");
    }
  }
  const repo = url.pathname.split("/")[1];
  const isPush = url.searchParams.get("service") === "git-receive-pack" || url.pathname.endsWith("/git-receive-pack");
  let claims = null;
  if (isPush) {
    const token = bearer(req);
    if (!token) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="agent-forge"' });
      return res.end("push requires a per-run token\n");
    }
    try {
      claims = verify(token, { repo, revoked });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      audit("refused", { repo, reason });
      res.writeHead(403, { "content-type": "text/plain" });
      return res.end(`AGENT FORGE: ${reason}\n`);
    }
  }
  const env = {
    ...process.env, GIT_PROJECT_ROOT: ROOT, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: url.pathname,
    QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers["content-type"] ?? "",
    REMOTE_USER: claims?.runId ?? "anonymous", REMOTE_ADDR: "127.0.0.1",
    GATE_CLAIMS: claims ? JSON.stringify(claims) : "",
  };
  if (req.headers["content-encoding"]) env.HTTP_CONTENT_ENCODING = req.headers["content-encoding"];
  if (req.headers["git-protocol"]) env.GIT_PROTOCOL = req.headers["git-protocol"];
  const cgi = spawn("git", ["-c", "http.receivepack=true", "http-backend"], { env });
  req.pipe(cgi.stdin);
  let head = Buffer.alloc(0), done = false;
  cgi.stdout.on("data", (chunk) => {
    if (done) return res.write(chunk);
    head = Buffer.concat([head, chunk]);
    const idx = head.indexOf("\r\n\r\n");
    if (idx < 0) return;
    done = true;
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
}).listen(PORT, () => console.log(`gate forge on :${PORT}`));
