// Spike 001 scenarios. Run: node scenarios.mjs   (cleanup: node scenarios.mjs --cleanup)
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { git, project, ensurePr, makeLog, GH_REPO, apiCallCount } from "./projector.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = join(HERE, "work");
const FORGE = join(WORK, "forge.git");
const STATE = join(WORK, "projection-state.json");
const LOG = join(HERE, "events.jsonl");
const REMOTE = `https://github.com/${GH_REPO}.git`;
const RUN_ID = Date.now().toString(36);
const NAMES = { main: `s001-${RUN_ID}`, race: `s001-race-${RUN_ID}`, prrace: `s001-prrace-${RUN_ID}` };

const results = [];
function check(name, ok, detail = {}) {
  results.push({ name, ok, ...detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`, JSON.stringify(detail));
}

async function cleanup() {
  const out = await run("gh", ["api", `repos/${GH_REPO}/pulls?state=open&per_page=100`]);
  for (const pr of JSON.parse(out.stdout)) {
    if (!pr.head.ref.startsWith("spike/forge-")) continue;
    await run("gh", ["api", "-X", "PATCH", `repos/${GH_REPO}/pulls/${pr.number}`, "-f", "state=closed"]);
    console.log("closed PR", pr.number);
  }
  const br = await run("gh", ["api", `repos/${GH_REPO}/branches?per_page=100`, "--jq", ".[].name"]);
  for (const b of br.stdout.split("\n").filter((x) => x.startsWith("spike/forge-"))) {
    await run("gh", ["api", "-X", "DELETE", `repos/${GH_REPO}/git/refs/heads/${b}`]);
    console.log("deleted branch", b);
  }
}

async function agentCommit(clone, branch, file, text) {
  writeFileSync(join(clone, file), text);
  await git(clone, ["add", file]);
  await git(clone, ["-c", "user.name=forge-agent", "-c", "user.email=agent@forge.local", "commit", "-qm", `agent: ${file}`]);
  await git(clone, ["push", "-q", "origin", `HEAD:refs/heads/agent/${branch}`]);
  return git(clone, ["rev-parse", "HEAD"]);
}

async function main() {
  if (process.argv.includes("--cleanup")) return cleanup();
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  writeFileSync(LOG, "");
  const log = makeLog(LOG);
  const t0 = Date.now();

  log("setup", "seed-forge", { from: GH_REPO });
  await git(WORK, ["clone", "-q", "--bare", "--single-branch", "--branch", "main", REMOTE, FORGE]);
  const agent = join(WORK, "agent");
  await git(WORK, ["clone", "-q", FORGE, agent]);

  // S1: agent lands work in the forge → projection opens a draft PR.
  const n = NAMES.main;
  await git(agent, ["checkout", "-qb", `agent/${n}`]);
  const a1 = await agentCommit(agent, n, `SPIKE_${n}.md`, "agent change 1\n");
  const before = apiCallCount();
  const r1 = await project({ forge: FORGE, name: n, stateFile: STATE, log });
  const st = JSON.parse(readFileSync(STATE, "utf8"));
  check("S1 first projection pushes + opens draft PR", r1.status === "projected" && !!st.prs[`spike/forge-${n}`], { sha: a1.slice(0, 12), apiCalls: apiCallCount() - before });

  // S2: re-run with no change → noop push, no duplicate PR.
  const before2 = apiCallCount();
  await project({ forge: FORGE, name: n, stateFile: STATE, log });
  const prs = JSON.parse((await run("gh", ["api", `repos/${GH_REPO}/pulls?head=${GH_REPO.split("/")[0]}:spike/forge-${n}&state=open`])).stdout);
  check("S2 idempotent re-projection (1 PR, no push)", prs.length === 1, { openPrs: prs.length, apiCalls: apiCallCount() - before2 });

  // S3: agent adds commits → fast-forward projection into the same PR.
  const a2 = await agentCommit(agent, n, `SPIKE_${n}.md`, "agent change 1\nagent change 2\n");
  const r3 = await project({ forge: FORGE, name: n, stateFile: STATE, log });
  const ghHead = (await run("git", ["ls-remote", REMOTE, `refs/heads/spike/forge-${n}`])).stdout.split("\t")[0];
  check("S3 fast-forward lands on GitHub", r3.status === "projected" && ghHead === a2, { ghHead: ghHead.slice(0, 12) });

  // S4: human pushes to the GitHub branch; agent pushes concurrently to the forge.
  const human = join(WORK, "human");
  await run("gh", ["repo", "clone", GH_REPO, human, "--", "-q", "--branch", `spike/forge-${n}`, "--single-branch"]);
  writeFileSync(join(human, `HUMAN_${n}.md`), "human review fix\n");
  await git(human, ["add", "."]);
  await git(human, ["-c", "commit.gpgsign=false", "-c", "user.name=human-reviewer", "-c", "user.email=human@example.com", "commit", "-qm", "human: review fix"]);
  await git(human, ["push", "-q", "origin", "HEAD"]);
  const humanSha = await git(human, ["rev-parse", "HEAD"]);
  log("human", "pushed-to-github", { sha: humanSha });
  const a3 = await agentCommit(agent, n, `SPIKE_${n}.md`, "agent change 1\nagent change 2\nagent change 3\n");
  const r4 = await project({ forge: FORGE, name: n, stateFile: STATE, log });
  const ghHead4 = (await run("git", ["ls-remote", REMOTE, `refs/heads/spike/forge-${n}`])).stdout.split("\t")[0];
  check("S4 divergence detected, human commit NOT overwritten", r4.status === "diverged" && ghHead4 === humanSha, { ghHead: ghHead4.slice(0, 12), forge: a3.slice(0, 12) });

  // S5: reconcile server-side (merge-tree, no worktree), then project fast-forward.
  const inbound = `refs/forge/inbound/${n}`;
  const tree = await git(FORGE, ["merge-tree", "--write-tree", `refs/heads/agent/${n}`, inbound]);
  const merge = await git(FORGE, ["-c", "user.name=forge", "-c", "user.email=forge@forge.local", "commit-tree", tree.split("\n")[0], "-p", `refs/heads/agent/${n}`, "-p", inbound, "-m", "forge: reconcile human change"]);
  await git(FORGE, ["update-ref", `refs/heads/agent/${n}`, merge, a3]); // CAS on the old value
  const s = JSON.parse(readFileSync(STATE, "utf8"));
  s.projected[`spike/forge-${n}`] = humanSha; // GitHub's tip is now our lease
  writeFileSync(STATE, JSON.stringify(s, null, 2));
  log("forge", "reconciled", { merge, parents: [a3, humanSha] });
  const r5 = await project({ forge: FORGE, name: n, stateFile: STATE, log });
  const ghHead5 = (await run("git", ["ls-remote", REMOTE, `refs/heads/spike/forge-${n}`])).stdout.split("\t")[0];
  const containsHuman = await git(FORGE, ["merge-base", "--is-ancestor", humanSha, ghHead5]).then(() => true, () => false);
  check("S5 reconcile → fast-forward keeps human commit", r5.status === "projected" && ghHead5 === merge && containsHuman, { ghHead: ghHead5.slice(0, 12) });

  // S6: two projectors race on a brand-new branch → one push, one PR.
  const rn = NAMES.race;
  await git(agent, ["checkout", "-qb", `agent/${rn}`, "origin/main"]);
  await agentCommit(agent, rn, `SPIKE_${rn}.md`, "race\n");
  const [ra, rb] = await Promise.allSettled([
    project({ forge: FORGE, name: rn, stateFile: STATE + ".a", log }),
    project({ forge: FORGE, name: rn, stateFile: STATE + ".b", log }),
  ]);
  const racePrs = JSON.parse((await run("gh", ["api", `repos/${GH_REPO}/pulls?head=${GH_REPO.split("/")[0]}:spike/forge-${rn}&state=open`])).stdout);
  check("S6 concurrent projectors converge on 1 PR, neither crashes", racePrs.length === 1 && ra.status === "fulfilled" && rb.status === "fulfilled", {
    a: ra.status === "fulfilled" ? ra.value.status : String(ra.reason).slice(0, 120),
    b: rb.status === "fulfilled" ? rb.value.status : String(rb.reason).slice(0, 120),
    openPrs: racePrs.length,
  });

  // S7: forced PR-create race — two ensurePr calls with empty caches on an already-pushed branch.
  const pn = NAMES.prrace;
  await git(agent, ["checkout", "-qb", `agent/${pn}`, "origin/main"]);
  const ps = await agentCommit(agent, pn, `SPIKE_${pn}.md`, "pr race\n");
  await git(FORGE, ["push", "-q", REMOTE, `${ps}:refs/heads/spike/forge-${pn}`]);
  const mk = (suffix) => { const f = `${STATE}.pr${suffix}`; writeFileSync(f, JSON.stringify({ projected: {}, prs: {} })); return f; };
  const fa = mk("a"), fb = mk("b");
  const pr7 = await Promise.allSettled([
    ensurePr({ dst: `spike/forge-${pn}`, base: "main", name: pn, sha: ps, state: { prs: {} }, stateFile: fa, log }),
    ensurePr({ dst: `spike/forge-${pn}`, base: "main", name: pn, sha: ps, state: { prs: {} }, stateFile: fb, log }),
  ]);
  const nums = pr7.map((r) => (r.status === "fulfilled" ? r.value : String(r.reason).slice(0, 100)));
  const adopted = readFileSync(LOG, "utf8").includes("create-race-adopted");
  check("S7 PR-create race: both resolve to the same PR number", nums[0] === nums[1] && typeof nums[0] === "number", { nums, adoptedPathHit: adopted });

  // S8: human deletes the projected branch on GitHub; agent keeps pushing → no resurrection.
  await run("gh", ["api", "-X", "DELETE", `repos/${GH_REPO}/git/refs/heads/spike/forge-${n}`]);
  log("human", "deleted-github-branch", { branch: `spike/forge-${n}` });
  await agentCommit(agent.replace(/$/, ""), n, `SPIKE_${n}.md`, "after delete\n").catch(async () => {
    await git(agent, ["checkout", "-q", `agent/${n}`]);
    await git(agent, ["pull", "-q", "--no-rebase", "origin", `agent/${n}`]);
    return agentCommit(agent, n, `SPIKE_${n}.md`, "after delete\n");
  });
  const r8 = await project({ forge: FORGE, name: n, stateFile: STATE, log });
  const gone = (await run("git", ["ls-remote", REMOTE, `refs/heads/spike/forge-${n}`])).stdout.trim() === "";
  check("S8 human-deleted branch is not resurrected", r8.status === "deleted-upstream" && gone, { status: r8.status });

  const summary = { runId: RUN_ID, repo: GH_REPO, durationMs: Date.now() - t0, totalApiCalls: apiCallCount(), results };
  writeFileSync(join(HERE, "results.json"), JSON.stringify(summary, null, 2));
  log("summary", "done", { passed: results.filter((r) => r.ok).length, total: results.length, apiCalls: apiCallCount() });
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
