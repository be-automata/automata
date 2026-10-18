// Stdio MCP server over the Kb. The principal comes from KB_TOKEN (signed by the control plane), never from tool args.
// Run: node --experimental-strip-types --no-warnings kb-server.ts   (env: KB_TOKEN, KB_KEY, KB_STORE, KB_AUDIT, KB_DRAFTS)
import { Server } from "../../../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js";
import { StdioServerTransport } from "../../../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "../../../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js";

import { Kb, verifyPrincipal } from "./kb.ts";

const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} unset`); return v; };
// Fail closed at boot: a bad or missing token means the server never starts serving.
const kb = new Kb(env("KB_STORE"), verifyPrincipal(process.env.KB_TOKEN, env("KB_KEY")), env("KB_AUDIT"), env("KB_DRAFTS"));

const server = new Server({ name: "kb", version: "0.0.1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "kb_search", description: "Search company knowledge you are allowed to see.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    { name: "kb_read", description: "Read one knowledge record by id.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    { name: "kb_propose", description: "Propose a new knowledge record. It is held for human approval; nothing is published.", inputSchema: { type: "object", properties: { scope: { type: "string" }, title: { type: "string" }, text: { type: "string" }, basedOn: { type: "array", items: { type: "string" } } }, required: ["scope", "title", "text"] } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const a = (req.params.arguments ?? {}) as Record<string, unknown>;
  try {
    // Extra args (scope, clearance, principal, ...) are ignored: identity is not negotiable from inside the session.
    const out = req.params.name === "kb_search" ? kb.search(String(a.query ?? ""))
      : req.params.name === "kb_read" ? kb.read(String(a.id ?? ""))
      : req.params.name === "kb_propose" ? kb.propose(String(a.scope ?? ""), String(a.title ?? ""), String(a.text ?? ""), Array.isArray(a.basedOn) ? a.basedOn.map(String) : [])
      : (() => { throw new Error(`unknown tool ${req.params.name}`); })();
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] };
  }
});
await server.connect(new StdioServerTransport());
