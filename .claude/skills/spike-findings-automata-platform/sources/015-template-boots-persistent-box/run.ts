// Spike 015: a compiled box template (spike 012) boots a persistent agent box (spike 013).
// Run (needs Docker / OrbStack, so outside the Claude sandbox):
//   node --experimental-strip-types --no-warnings run.ts
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";

import type { BatteriesManifest } from "../../../packages/worker/src/agent-run/batteries-manifest.ts";
import { canonicalJson, compile, parseTemplate, Registry, type Compiled, type TemplateSpec } from "../012-box-template-manifest/template.ts";

const HERE = import.meta.dirname;
const REPO = join(HERE, "../../..");
const WORK = join(HERE, "work");
const BASE_IMAGE = "node:24"; // stand-in for the production base (renderBase), which takes minutes to build
const batteries = JSON.parse(readFileSync(join(REPO, "packages/worker/deploy/batteries.json"), "utf8")) as BatteriesManifest;

const events: object[] = [];
const log = (cat: string, data: object) => { events.push({ at: new Date().toISOString(), cat, ...data }); };
interface Check { name: string; ok: boolean; detail: unknown }
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail: unknown) => {
  checks.push({ name, ok, detail });
  log("check", { name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${JSON.stringify(detail).slice(0, 200)}`);
};
const docker = (...a: string[]) => execFileSync("docker", a, { encoding: "utf8", maxBuffer: 1 << 26 }).trim();
const dockerIn = (input: string, ...a: string[]) => execFileSync("docker", a, { encoding: "utf8", input }).trim();
const timed = <T,>(fn: () => T): [number, T] => { const t = performance.now(); const r = fn(); return [Math.round(performance.now() - t), r]; };
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// ---- control plane ---------------------------------------------------------------
/** What 012's runtime manifest lacked: WHICH env var each secret feeds. */
interface BoxRuntime extends Omit<Compiled["runtime"], "secretRefs"> { init: boolean; secretBindings: Record<string, string> }
interface BoxCompiled { name: string; digest: string; dockerfile: string; runtime: BoxRuntime }

function compileBox(spec: TemplateSpec & { init?: boolean }): BoxCompiled {
  const c = compile(spec, batteries);
  const secretBindings: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec.env ?? {})) if (typeof v !== "string") secretBindings[k] = v.secret;
  const { secretRefs: _drop, ...rest } = c.runtime;
  void _drop;
  const runtime: BoxRuntime = { ...rest, init: spec.init ?? true, secretBindings };
  // Swap the production base for a small one; keep 012's appended template block verbatim.
  const block = c.dockerfile.includes("\n# ---- template:") ? c.dockerfile.slice(c.dockerfile.indexOf("\n# ---- template:")) : "";
  const dockerfile = `FROM ${BASE_IMAGE}${block}\nCOPY app /app\nRUN mkdir -p /home/agent\nCMD ["node", "/app/agent.mjs"]\n`;
  const digest = createHash("sha256").update(canonicalJson({ dockerfile, runtime })).digest("hex").slice(0, 12);
  return { name: c.name, digest, dockerfile, runtime };
}

/** Fake secret store. Values are random per run so no secret-shaped literal exists on disk. */
const SECRET_STORE = new Map<string, string>([
  ["ANTHROPIC_API_KEY", `FAKESECRET015a${randomBytes(12).toString("hex")}`],
  ["ORG_STAGING_DATABASE_URL", `FAKESECRET015b${randomBytes(12).toString("hex")}`],
]);
const sha12 = (v: string) => createHash("sha256").update(v).digest("hex").slice(0, 12);

const tag = (c: BoxCompiled) => `spike015-${c.name}:${c.digest}`;
const built = new Map<string, number>();
function buildImage(c: BoxCompiled): number {
  if (docker("images", "-q", tag(c))) return 0; // content-addressed: identical digest never rebuilds
  const ctx = join(WORK, c.digest);
  rmSync(ctx, { recursive: true, force: true });
  mkdirSync(ctx, { recursive: true });
  cpSync(join(HERE, "app"), join(ctx, "app"), { recursive: true });
  writeFileSync(join(ctx, "Dockerfile"), c.dockerfile);
  writeFileSync(join(ctx, "runtime.json"), JSON.stringify(c.runtime, null, 2));
  const [ms] = timed(() => docker("build", "-q", "--label", `automata.template.digest=${c.digest}`, "-t", tag(c), ctx));
  built.set(c.digest, ms);
  log("build", { tag: tag(c), ms });
  return ms;
}

const box = (id: string) => `spike015-${id}`;
const vol = (id: string) => `spike015-vol-${id}`;
function run(id: string, c: BoxCompiled) {
  const r = c.runtime;
  docker("run", "-d", "--name", box(id),
    ...(r.init ? ["--init"] : []),
    "--memory", `${r.resources.memoryGb}g`, "--cpus", String(r.resources.cpu),
    "-v", `${vol(id)}:/home/agent`,
    // Secrets live on a per-container tmpfs: RAM only, never in the image, the volume, `docker diff` or `docker inspect`.
    "--mount", "type=tmpfs,destination=/run/secrets,tmpfs-mode=0700",
    "--label", `automata.template=${c.name}`, "--label", `automata.template.digest=${c.digest}`,
    tag(c));
}
/** Boot-time resolution: control plane pipes each value over exec stdin (no argv, no env, no file on host). */
function injectSecrets(id: string, c: BoxCompiled) {
  for (const [envName, secretName] of Object.entries(c.runtime.secretBindings)) {
    const v = SECRET_STORE.get(secretName);
    if (v === undefined) throw new Error(`secret ${secretName} not in store`);
    dockerIn(v, "exec", "-i", box(id), "sh", "-c", `umask 077; cat > /run/secrets/${envName}`);
  }
}
interface TurnOut { memory: string[]; session: string; bootId: string; boots: number; rootfsScratch: string | null; role: string | null; secrets: { name: string; sha: string }[]; pid1EnvHasSecretNames: string[] }
const turn = (id: string, ...a: string[]): TurnOut => JSON.parse(docker("exec", box(id), "node", "/app/turn.mjs", ...a)) as TurnOut;
function waitHealthy(id: string, prevBoot?: string): TurnOut {
  for (let i = 0; i < 400; i++) {
    try { const s = turn(id, "state"); if (s.bootId && s.bootId !== prevBoot) return s; } catch { /* still starting */ }
    sleep(25);
  }
  throw new Error(`${id} never healthy`);
}
const imageOf = (id: string) => docker("inspect", "-f", "{{.Image}}", box(id));
const imageId = (c: BoxCompiled) => docker("images", "--no-trunc", "-q", tag(c));

function cleanup() {
  for (const id of ["a", "b", "c", "envdemo"]) { try { docker("rm", "-f", box(id)); } catch { /* absent */ } }
  for (const id of ["a", "b", "c"]) { try { docker("volume", "rm", "-f", vol(id)); } catch { /* absent */ } }
  const imgs = docker("images", "-q", "--filter", "reference=spike015-*");
  if (imgs) { try { docker("rmi", "-f", ...imgs.split("\n")); } catch { /* in use */ } }
}

const results: Record<string, unknown> = {};
try {
  cleanup();
  const yaml1 = readFileSync(join(HERE, "templates/scope-agent.yaml"), "utf8");
  const spec1 = parseTemplate(yaml1) as TemplateSpec & { init?: boolean };
  const rev1c = compileBox(spec1);

  // 1. Compile: names only, nothing secret-ish in the Dockerfile
  check("compile: runtime binds env->secret NAMES; no values anywhere in the compiled output",
    canonicalJson(rev1c.runtime.secretBindings) === canonicalJson({ ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY", DATABASE_URL: "ORG_STAGING_DATABASE_URL" })
      && ![...SECRET_STORE.values()].some((v) => (rev1c.dockerfile + JSON.stringify(rev1c.runtime)).includes(v)),
    rev1c.runtime.secretBindings);
  check("compile: Dockerfile carries no secret NAMES either (only plain ENV)",
    !/ANTHROPIC_API_KEY|DATABASE_URL|ORG_STAGING/.test(rev1c.dockerfile) && /ENV AGENT_ROLE="support-digest"/.test(rev1c.dockerfile),
    rev1c.dockerfile.split("\n").filter((l) => l.startsWith("ENV")));
  check("compile: init defaults to true in the runtime manifest", rev1c.runtime.init === true, { init: rev1c.runtime.init });

  const reg = new Registry();
  const r1 = reg.publish({ name: rev1c.name, digest: rev1c.digest, dockerfile: rev1c.dockerfile, runtime: rev1c.runtime as unknown as Compiled["runtime"] });
  results.buildRev1Ms = buildImage(rev1c);

  // 2. Image is clean: history and every layer
  const hist = docker("history", "--no-trunc", "--format", "{{.CreatedBy}}", tag(rev1c));
  const saveHits = execFileSync("sh", ["-c", `docker save "$1" | LC_ALL=C grep -a -c -F -e "$2" -e "$3" || true`, "sh", tag(rev1c), ...SECRET_STORE.values()], { encoding: "utf8", maxBuffer: 1 << 26 }).trim();
  check("image: no secret value in `docker history` or any saved layer; no secret name in history",
    ![...SECRET_STORE.values()].some((v) => hist.includes(v)) && !/ANTHROPIC_API_KEY|DATABASE_URL/.test(hist) && saveHits === "0",
    { saveHits, historyLines: hist.split("\n").length });

  // 3. Launch two instances from rev 1 (a, b), each with its own $HOME volume
  reg.launch("a", `${rev1c.name}@${r1.revision}`);
  reg.launch("b", `${rev1c.name}@${r1.revision}`);
  const [launchMs] = timed(() => { run("a", rev1c); return waitHealthy("a"); });
  run("b", rev1c);
  waitHealthy("b");
  results.launchToHealthyMs = launchMs;
  check("box: HostConfig.Init comes from the template", docker("inspect", "-f", "{{.HostConfig.Init}}", box("a")) === "true", {});

  const [injectMs] = timed(() => injectSecrets("a", rev1c));
  results.injectSecretsMs = injectMs;
  injectSecrets("b", rev1c);
  let s = turn("a", "remember", "customer prefers weekly digest on Mondays");
  const expectSecrets = Object.entries(rev1c.runtime.secretBindings).map(([n, sec]) => ({ name: n, sha: sha12(SECRET_STORE.get(sec) as string) })).sort((x, y) => x.name.localeCompare(y.name));
  check("secrets (tmpfs): agent sees the right values by name; PID 1 env never had them",
    canonicalJson(s.secrets) === canonicalJson(expectSecrets) && s.pid1EnvHasSecretNames.length === 0, s.secrets.map((x) => x.name));
  const inspect = docker("inspect", box("a"));
  const diff = docker("diff", box("a"));
  const volHits = execFileSync("docker", ["run", "--rm", "-v", `${vol("a")}:/v:ro`, "alpine:3", "sh", "-c", `grep -rlF -e "$0" -e "$1" /v || true`, ...SECRET_STORE.values()], { encoding: "utf8" }).trim();
  check("secrets (tmpfs): absent from `docker inspect`, `docker diff` and the $HOME volume",
    ![...SECRET_STORE.values()].some((v) => inspect.includes(v)) && !diff.split("\n").some((l) => l.includes("/run/secrets/")) && volHits === "",
    { diffUnderSecrets: diff.split("\n").filter((l) => l.includes("/run/secrets")), volHits });

  // 3b. The obvious mechanism (`docker run -e`) leaks: prove it so nobody ships it
  const leakVal = SECRET_STORE.get("ORG_STAGING_DATABASE_URL") as string;
  docker("run", "-d", "--name", box("envdemo"), "-e", `DATABASE_URL=${leakVal}`, BASE_IMAGE, "sleep", "30");
  const envInspect = docker("inspect", box("envdemo"));
  docker("rm", "-f", box("envdemo"));
  check("anti-pattern: `docker run -e` puts the value in `docker inspect` Config.Env (leak confirmed)", envInspect.includes(leakVal), { leaked: envInspect.includes(leakVal) });

  // 4. Stop/start: init makes stop fast even though the agent has no SIGTERM handler; tmpfs secrets are gone until re-injected
  const [stopMs] = timed(() => docker("stop", box("a")));
  const exitCode = docker("inspect", "-f", "{{.State.ExitCode}}", box("a"));
  results.stopMs = stopMs;
  check("init: stop is graceful and fast with no SIGTERM handler in the agent (< 2 s, not SIGKILL 137)", stopMs < 2000 && exitCode !== "137", { stopMs, exitCode });
  // Control: the same agent from an init:false template is SIGKILLed after the 10 s grace period.
  const noInit = compileBox({ ...spec1, init: false });
  buildImage(noInit);
  run("c", noInit);
  waitHealthy("c");
  const [noInitStopMs] = timed(() => docker("stop", box("c")));
  const noInitExit = docker("inspect", "-f", "{{.State.ExitCode}}", box("c"));
  docker("rm", "-f", box("c"));
  results.noInitStopMs = noInitStopMs;
  check("control: init:false template -> stop waits the full grace period and SIGKILLs (137)", noInitStopMs > 9000 && noInitExit === "137", { noInitStopMs, noInitExit });
  docker("start", box("a"));
  s = waitHealthy("a", s.bootId);
  check("wake: tmpfs secrets do NOT survive stop (must be re-resolved on every wake)", s.secrets.length === 0, s.secrets);
  const [reinjectMs] = timed(() => injectSecrets("a", rev1c));
  s = turn("a", "state");
  results.reinjectMs = reinjectMs;
  check("wake: re-injection restores secrets; memory survived", s.secrets.length === 2 && s.memory.length === 1, { secrets: s.secrets.length, memory: s.memory });

  // 5. Publish rev N+1: nothing moves
  const yaml2 = yaml1.replace("AGENT_ROLE: support-digest", "AGENT_ROLE: support-digest-v2");
  const rev2c = compileBox(parseTemplate(yaml2) as TemplateSpec & { init?: boolean });
  const again = compileBox(parseTemplate(yaml1.replace("init: true\n", "init: true\n").replace(/env:\n  AGENT_ROLE: support-digest\n  ANTHROPIC_API_KEY: \{ secret: ANTHROPIC_API_KEY \}/, "env:\n  ANTHROPIC_API_KEY: { secret: ANTHROPIC_API_KEY }\n  AGENT_ROLE: support-digest")) as TemplateSpec & { init?: boolean });
  check("digest: reordering env keys keeps the digest (no rebuild, no spurious update)", again.digest === rev1c.digest && buildImage(again) === 0, { rev1: rev1c.digest, reordered: again.digest });
  const r2 = reg.publish({ name: rev2c.name, digest: rev2c.digest, dockerfile: rev2c.dockerfile, runtime: rev2c.runtime as unknown as Compiled["runtime"] });
  results.buildRev2Ms = buildImage(rev2c);
  check("rev N+1 published: both instances stay pinned to rev 1 and keep running the rev-1 image",
    r2.revision === 2 && reg.instances.get("a")?.pinned === 1 && reg.instances.get("b")?.pinned === 1 && imageOf("a") === imageId(rev1c) && imageOf("b") === imageId(rev1c),
    { rev: r2.revision, a: reg.instances.get("a")?.pinned, b: reg.instances.get("b")?.pinned });

  // 6. update(a): recreate on rev 2 with the same volume
  const before = turn("a", "state");
  reg.update("a");
  const target = reg.effective("a");
  const [recreateMs, afterRec] = timed(() => {
    docker("rm", "-f", box("a"));
    run("a", target.digest === rev2c.digest ? rev2c : rev1c);
    const h = waitHealthy("a");
    injectSecrets("a", rev2c);
    return { ...h, ...turn("a", "state") };
  });
  results.recreateToReadyMs = recreateMs;
  check("update(a) -> rev 2: $HOME (memory, session) survives; rootfs scratch reset; new env applied",
    afterRec.memory.length === 1 && afterRec.session === before.session && afterRec.role === "support-digest-v2"
      && afterRec.rootfsScratch?.includes(afterRec.bootId) === true && imageOf("a") === imageId(rev2c),
    { role: afterRec.role, memory: afterRec.memory.length, scratch: afterRec.rootfsScratch });
  check("update(a) does not move b", reg.instances.get("b")?.pinned === 1 && imageOf("b") === imageId(rev1c) && turn("b", "state").role === "support-digest", {});

  // 7. Rollback is update(a, 1)
  reg.update("a", 1);
  docker("rm", "-f", box("a"));
  run("a", rev1c);
  const rb = waitHealthy("a");
  check("rollback update(a, 1): back on rev-1 image, memory intact", rb.role === "support-digest" && rb.memory.length === 1 && imageOf("a") === imageId(rev1c), { role: rb.role });
} catch (e) {
  check("runner crashed", false, e instanceof Error ? e.message : String(e));
} finally {
  cleanup();
  rmSync(WORK, { recursive: true, force: true });
  results.checks = checks;
  writeFileSync(join(HERE, "results.json"), JSON.stringify(results, null, 2));
  writeFileSync(join(HERE, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const passed = checks.filter((c) => c.ok).length;
  console.log(`\n${passed}/${checks.length} passed`, JSON.stringify({ ...results, checks: undefined }));
  process.exitCode = passed === checks.length ? 0 : 1;
}
