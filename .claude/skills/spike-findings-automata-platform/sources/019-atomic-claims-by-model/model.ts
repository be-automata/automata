// Real model calls through the local `claude` CLI (subscription auth, never ANTHROPIC_API_KEY).
// Every response is cached by prompt hash, so reruns are free and deterministic.
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const CACHE = join(import.meta.dirname, "cache");
const MODEL = "sonnet";
const SYSTEM = "You extract and update grounded facts from technical documents. Output only the JSON requested, with no prose and no code fences.";

export interface ModelResult { text: string; costUsd: number; inputTokens: number; outputTokens: number; cached: boolean; model: string }

const args = (prompt: string) => ["-p", "--model", MODEL, "--output-format", "json", "--tools", "", "--strict-mcp-config",
  "--setting-sources", "", "--no-session-persistence", "--system-prompt", SYSTEM, prompt];
const env = () => { const e = { ...process.env }; delete e.ANTHROPIC_API_KEY; return e; };
const keyOf = (prompt: string) => createHash("sha256").update(`${MODEL}\0${SYSTEM}\0${prompt}`).digest("hex").slice(0, 24);

function parse(raw: string, cached: boolean): ModelResult {
  const j = JSON.parse(raw) as { result: string; is_error: boolean; total_cost_usd: number; usage: { input_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; output_tokens: number }; modelUsage: Record<string, unknown> };
  if (j.is_error) throw new Error(`model error: ${j.result}`);
  const u = j.usage;
  return { text: j.result, costUsd: j.total_cost_usd, inputTokens: u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens, outputTokens: u.output_tokens, cached, model: Object.keys(j.modelUsage)[0] ?? MODEL };
}

function fromCache(prompt: string): ModelResult | null {
  const p = join(CACHE, `${keyOf(prompt)}.json`);
  return existsSync(p) ? parse(readFileSync(p, "utf8"), true) : null;
}
function store(prompt: string, raw: string): void {
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(join(CACHE, `${keyOf(prompt)}.json`), raw);
}

export function askSync(prompt: string): ModelResult {
  const hit = fromCache(prompt);
  if (hit) return hit;
  const raw = execFileSync("claude", args(prompt), { cwd: tmpdir(), env: env(), encoding: "utf8", maxBuffer: 1 << 26, timeout: 600_000 });
  store(prompt, raw);
  return parse(raw, false);
}

const run = promisify(execFile);
export async function ask(prompt: string): Promise<ModelResult> {
  const hit = fromCache(prompt);
  if (hit) return hit;
  const { stdout } = await run("claude", args(prompt), { cwd: tmpdir(), env: env(), encoding: "utf8", maxBuffer: 1 << 26, timeout: 600_000 });
  store(prompt, stdout);
  return parse(stdout, false);
}

/** Models sometimes wrap JSON in fences despite instructions; accept the first top-level array. */
export function jsonArray(text: string): unknown[] {
  const a = text.indexOf("["), b = text.lastIndexOf("]");
  if (a < 0 || b < a) throw new Error(`no JSON array in model output: ${text.slice(0, 120)}`);
  const v: unknown = JSON.parse(text.slice(a, b + 1));
  if (!Array.isArray(v)) throw new Error("model output is not an array");
  return v;
}
