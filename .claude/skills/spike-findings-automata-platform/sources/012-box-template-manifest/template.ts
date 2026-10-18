// Spike 012: a declarative box template compiled through the repo's OWN renderer and validators.
// automata.template.yaml -> { Dockerfile (build-time, secret-free), runtime manifest (secret NAMES), digest }
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { findBatteriesManifestError, type BatteriesManifest } from "../../../packages/worker/src/agent-run/batteries-manifest.ts";
import { McpConfigSchema } from "../../../packages/sandbox/src/mcp-config.ts";

const REPO = join(import.meta.dirname, "../../..");
const req = createRequire(join(REPO, "packages/sandbox-image/package.json"));
// Resolved from the image package, as renderDockerfile does. Minimal local shapes: the spike has no type deps.
interface HandlebarsLike { compile(src: string): (ctx: object) => string; registerHelper(name: string, fn: (...a: unknown[]) => unknown): void }
const Handlebars = req("handlebars") as HandlebarsLike;
const YAML = createRequire(join(REPO, "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/package.json"))("yaml") as { parse(text: string): unknown };
Handlebars.registerHelper("eq", (a: unknown, b: unknown) => a === b);

export type Provider = "docker" | "e2b" | "daytona";
export type Egress = "open" | "allowlist" | "none";
const EGRESS_RANK: Record<Egress, number> = { open: 0, allowlist: 1, none: 2 };

/** Env values are either plain config or a reference to a secret held by the control plane. */
export type EnvValue = string | { secret: string };
export interface TemplateSpec {
  name: string;
  extends?: string;
  provider?: Provider;
  apt?: string[];
  npm?: string[]; // "pkg@exact.version" only
  batteries?: string[]; // ids from packages/worker/deploy/batteries.json
  skills?: string[]; // live-skill names resolved at run time (repo_skills), never baked
  mcp?: Record<string, unknown>;
  env?: Record<string, EnvValue>;
  setup?: string; // runs at BOOT against the checkout, not at build
  resources?: { cpu?: number; memoryGb?: number; diskGb?: number };
  policy?: { egress?: Egress; allowHosts?: string[]; maxRunMinutes?: number };
}
export interface Compiled {
  name: string;
  digest: string; // content address of everything below except the name
  dockerfile: string;
  runtime: {
    provider: Provider;
    batteries: { id: string; requires: string[] }[];
    skills: string[];
    mcpConfig: { mcpServers: Record<string, unknown> };
    env: Record<string, string>; // plain values only
    secretRefs: string[]; // names; the control plane injects values per run
    setup?: string;
    resources: { cpu: number; memoryGb: number; diskGb: number };
    policy: { egress: Egress; allowHosts: string[]; maxRunMinutes: number };
  };
}

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

// Shapes that look like credentials. A template is a reviewable, shareable artifact: no secret may live in it.
const SECRET_SHAPES: [string, RegExp][] = [
  ["anthropic key", /sk-ant-[A-Za-z0-9_-]{10,}/],
  ["openai key", /sk-[A-Za-z0-9]{20,}/],
  ["github token", /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ["aws access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["bearer header", /\bBearer\s+[A-Za-z0-9._-]{16,}/i],
];
const SECRETISH_NAME = /(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL)/;
const APT = /^[a-z0-9][a-z0-9.+-]*$/;
const NPM_PINNED = /^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/;
const NAME = /^[a-z][a-z0-9-]{1,62}$/;
const ENV_KEY = /^[A-Z][A-Z0-9_]*$/;

function scanForSecrets(where: string, v: unknown): void {
  if (typeof v === "string") {
    for (const [label, re] of SECRET_SHAPES) if (re.test(v)) throw new TemplateError(`${where}: looks like an inline ${label}; use { secret: NAME }`);
  } else if (Array.isArray(v)) v.forEach((x, i) => scanForSecrets(`${where}[${i}]`, x));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) scanForSecrets(`${where}.${k}`, x);
}

/** Key-order-independent JSON: reordering env/mcp keys in YAML must not mint a new revision. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

export function parseTemplate(text: string): TemplateSpec {
  const raw: unknown = YAML.parse(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TemplateError("template must be a mapping");
  scanForSecrets("template", raw); // before anything else: a bad template is never stored
  const t = raw as TemplateSpec;
  if (typeof t.name !== "string" || !NAME.test(t.name)) throw new TemplateError(`name must match ${NAME}`);
  for (const p of t.apt ?? []) if (!APT.test(p)) throw new TemplateError(`apt: bad package "${p}"`);
  for (const p of t.npm ?? []) if (!NPM_PINNED.test(p)) throw new TemplateError(`npm: "${p}" must be pinned to an exact version`);
  for (const [k, v] of Object.entries(t.env ?? {})) {
    if (!ENV_KEY.test(k)) throw new TemplateError(`env.${k}: bad key`);
    if (typeof v === "string" && SECRETISH_NAME.test(k)) throw new TemplateError(`env.${k}: secret-named key with a literal value; use { secret: ${k} }`);
    if (typeof v !== "string" && (typeof v !== "object" || typeof v.secret !== "string" || !ENV_KEY.test(v.secret)))
      throw new TemplateError(`env.${k}: must be a string or { secret: NAME }`);
  }
  return t;
}

/**
 * org/repo templates extend a parent. Unions for capabilities, child wins for config,
 * and policy may only TIGHTEN (qm's rule: a narrower scope never loosens the posture).
 */
export function mergeTemplates(parent: TemplateSpec, child: TemplateSpec): TemplateSpec {
  const uniq = <T,>(a: T[] = [], b: T[] = []) => [...new Set([...a, ...b])];
  const pp = parent.policy ?? {}, cp = child.policy ?? {};
  if (cp.egress && pp.egress && EGRESS_RANK[cp.egress] < EGRESS_RANK[pp.egress])
    throw new TemplateError(`${child.name}: policy.egress "${cp.egress}" loosens parent "${pp.egress}"`);
  if (cp.maxRunMinutes && pp.maxRunMinutes && cp.maxRunMinutes > pp.maxRunMinutes)
    throw new TemplateError(`${child.name}: policy.maxRunMinutes ${cp.maxRunMinutes} exceeds parent ${pp.maxRunMinutes}`);
  if (pp.egress === "allowlist" && cp.allowHosts) {
    const extra = cp.allowHosts.filter((h) => !(pp.allowHosts ?? []).includes(h));
    if (extra.length) throw new TemplateError(`${child.name}: allowHosts adds ${extra.join(", ")} beyond the parent allowlist`);
  }
  return {
    name: child.name,
    provider: child.provider ?? parent.provider,
    apt: uniq(parent.apt, child.apt),
    npm: uniq(parent.npm, child.npm),
    batteries: uniq(parent.batteries, child.batteries),
    skills: uniq(parent.skills, child.skills),
    mcp: { ...parent.mcp, ...child.mcp },
    env: { ...parent.env, ...child.env },
    setup: [parent.setup, child.setup].filter(Boolean).join("\n") || undefined,
    resources: { ...parent.resources, ...child.resources },
    policy: { ...pp, ...cp, allowHosts: cp.allowHosts ?? pp.allowHosts },
  };
}

export function renderBase(provider: Provider): string {
  // Same template, same helper, same input as packages/sandbox-image/src/render-dockerfile.ts.
  const hbs = readFileSync(join(REPO, "packages/sandbox-image/Dockerfile.hbs"), "utf8");
  return Handlebars.compile(hbs)({ sandboxProvider: provider });
}

export function compile(t: TemplateSpec, batteries: BatteriesManifest): Compiled {
  const manifestError = findBatteriesManifestError(batteries); // the same guard CI and the installer run
  if (manifestError) throw new TemplateError(`batteries.json invalid: ${manifestError}`);
  const provider = t.provider ?? "docker";
  const known = new Map(batteries.packs.map((p) => [p.id, p.requires ?? []]));
  const sel = (t.batteries ?? []).map((id) => {
    const requires = known.get(id);
    if (!requires) throw new TemplateError(`batteries: unknown pack "${id}" (known: ${[...known.keys()].join(", ")})`);
    return { id, requires: [...requires] };
  });
  const mcpConfig = { mcpServers: t.mcp ?? {} };
  const mcpOk = McpConfigSchema.safeParse(mcpConfig);
  if (!mcpOk.success) throw new TemplateError(`mcp: ${mcpOk.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const env: Record<string, string> = {};
  const secretRefs: string[] = [];
  for (const [k, v] of Object.entries(t.env ?? {})) {
    if (typeof v === "string") env[k] = v; else secretRefs.push(v.secret);
  }
  const extra: string[] = [];
  if (t.apt?.length) extra.push(`RUN apt-get update && apt-get install -y --no-install-recommends ${[...t.apt].sort().join(" ")} \\\n    && apt-get clean && rm -rf /var/lib/apt/lists/*`);
  if (t.npm?.length) extra.push(`RUN npm install -g ${[...t.npm].sort().join(" ")}`);
  // Plain env is baked; secrets are never ENV/ARG in the image: the run gets them at boot.
  const plain = Object.entries(env).sort(([a], [b]) => a.localeCompare(b));
  if (plain.length) extra.push(`ENV ${plain.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" \\\n    ")}`);
  const base = renderBase(provider);
  const dockerfile = extra.length ? `${base}\n# ---- template: ${t.name} ----\n${extra.join("\n\n")}\n` : base;
  const runtime: Compiled["runtime"] = {
    provider,
    batteries: sel,
    skills: [...(t.skills ?? [])].sort(),
    mcpConfig,
    env,
    secretRefs: [...new Set(secretRefs)].sort(),
    ...(t.setup ? { setup: t.setup } : {}),
    resources: { cpu: t.resources?.cpu ?? 2, memoryGb: t.resources?.memoryGb ?? 4, diskGb: t.resources?.diskGb ?? 20 },
    policy: { egress: t.policy?.egress ?? "open", allowHosts: t.policy?.allowHosts ?? [], maxRunMinutes: t.policy?.maxRunMinutes ?? 60 },
  };
  const digest = createHash("sha256").update(canonicalJson({ dockerfile, runtime })).digest("hex").slice(0, 12);
  if (/sk-ant-|ghp_|AKIA|PRIVATE KEY/.test(dockerfile + JSON.stringify(runtime))) throw new TemplateError("compiled output contains a credential shape"); // belt and braces
  return { name: t.name, digest, dockerfile, runtime };
}

// ---- revisions: Agent37-style pinning ---------------------------------------------
export interface Revision { revision: number; digest: string; compiled: Compiled; at: string }
export interface Instance { id: string; template: string; pinned: number }
export class Registry {
  revisions = new Map<string, Revision[]>();
  instances = new Map<string, Instance>();
  /** Same digest -> same revision (idempotent publish); new digest -> N+1. Instances never move. */
  publish(c: Compiled): Revision {
    const list = this.revisions.get(c.name) ?? [];
    const last = list.at(-1);
    if (last && last.digest === c.digest) return last;
    const rev = { revision: (last?.revision ?? 0) + 1, digest: c.digest, compiled: c, at: new Date().toISOString() };
    this.revisions.set(c.name, [...list, rev]);
    return rev;
  }
  launch(id: string, ref: string): Instance {
    const [name, pin] = ref.split("@") as [string, string | undefined];
    const list = this.revisions.get(name) ?? [];
    const rev = pin ? list.find((r) => r.revision === Number(pin)) : list.at(-1);
    if (!rev) throw new TemplateError(`no revision ${ref}`);
    const inst = { id, template: name, pinned: rev.revision };
    this.instances.set(id, inst);
    return inst;
  }
  /** Explicit, per instance; rollback is an update to an older pin. */
  update(id: string, to?: number): Instance {
    const inst = this.instances.get(id);
    if (!inst) throw new TemplateError(`no instance ${id}`);
    const list = this.revisions.get(inst.template) ?? [];
    const target = to ?? list.at(-1)?.revision;
    if (!list.some((r) => r.revision === target)) throw new TemplateError(`no revision ${inst.template}@${to}`);
    const next = { ...inst, pinned: target as number }; // checked by the .some() above
    this.instances.set(id, next);
    return next;
  }
  effective(id: string): Revision {
    const inst = this.instances.get(id)!; // callers pass ids returned by launch()
    return this.revisions.get(inst.template)!.find((r) => r.revision === inst.pinned)!;
  }
}
