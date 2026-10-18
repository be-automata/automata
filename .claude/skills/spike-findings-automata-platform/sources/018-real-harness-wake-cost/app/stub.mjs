// Minimal Anthropic Messages API stub. Logs WHEN each request arrives and WHAT context it carries.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const HOME = process.env.HOME ?? "/home/agent";
mkdirSync(HOME, { recursive: true });
const LOG = `${HOME}/stub.jsonl`;
const bootId = randomUUID();
const FACT = /ZEBRA-7731/;

const sse = (res, events) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
};
createServer((req, res) => {
  const at = Date.now();
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let j = {};
    try { j = JSON.parse(body || "{}"); } catch { /* non-JSON probe */ }
    const msgs = Array.isArray(j.messages) ? j.messages : [];
    const isMain = req.url?.startsWith("/v1/messages") && !req.url.includes("count_tokens") && msgs.length > 0;
    // Filler bytes per reply (grows a session for the large-session runs); read per request so the orchestrator can change it live.
    const pad = existsSync(`${HOME}/pad`) ? Number(readFileSync(`${HOME}/pad`, "utf8")) : 0;
    appendFileSync(LOG, JSON.stringify({ at, bootId, method: req.method, url: req.url, bytes: body.length, messages: msgs.length, hasFact: FACT.test(body), stream: j.stream === true, model: j.model }) + "\n");
    if (!isMain) { res.writeHead(req.url?.includes("count_tokens") ? 200 : 404, { "content-type": "application/json" }); res.end(JSON.stringify({ input_tokens: 1 })); return; }
    const text = `ack ${msgs.length}` + (pad ? " " + "x".repeat(pad) : "");
    const id = `msg_${randomUUID().slice(0, 8)}`;
    const usage = { input_tokens: Math.ceil(body.length / 4), output_tokens: Math.ceil(text.length / 4) };
    if (j.stream) {
      sse(res, [
        ["message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: j.model, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: usage.output_tokens } }],
        ["message_stop", { type: "message_stop" }],
      ]);
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id, type: "message", role: "assistant", model: j.model, content: [{ type: "text", text }], stop_reason: "end_turn", usage }));
    }
  });
}).listen(8787, "127.0.0.1", () => writeFileSync(`${HOME}/heartbeat.json`, JSON.stringify({ bootId, at: Date.now() })));
