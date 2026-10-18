// Spike 001 — forge → GitHub projection.
// The forge (a local bare repo) is the source of truth for agent branches.
// GitHub receives a *projection*: the branch is mirrored with a lease on the
// last SHA we projected, and a draft PR is opened/refreshed idempotently.
// If a human moved the GitHub branch, the lease fails and we record DIVERGED
// instead of overwriting; the human commits are imported into the forge.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";

const run = promisify(execFile);
export const GH_REPO = process.env.SPIKE_GH_REPO ?? "be-automata/astro-web";
const REMOTE = `https://github.com/${GH_REPO}.git`;
// Credentials come from gh's helper — never a token in argv (ps-visible).
const CRED = ["-c", "commit.gpgsign=false", "-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];

export function makeLog(file) {
  return (category, event, data = {}) => {
    const row = { ts: new Date().toISOString(), category, event, ...data };
    appendFileSync(file, JSON.stringify(row) + "\n");
    console.log(`[${row.ts}] ${category}/${event}`, Object.keys(data).length ? JSON.stringify(data) : "");
    return row;
  };
}

export async function git(cwd, args, opts = {}) {
  const { stdout } = await run("git", [...CRED, ...args], { cwd, maxBuffer: 1 << 26, ...opts });
  return stdout.trim();
}

let apiCalls = 0;
export const apiCallCount = () => apiCalls;
async function gh(args) {
  apiCalls++;
  const { stdout } = await run("gh", ["api", ...args], { maxBuffer: 1 << 24 });
  return stdout ? JSON.parse(stdout) : null;
}

function loadState(stateFile) {
  return existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { projected: {}, prs: {} };
}

// Project one forge branch `agent/<name>` → GitHub `spike/forge-<name>`.
export async function project({ forge, name, stateFile, log, base = "main" }) {
  const state = loadState(stateFile);
  const src = `refs/heads/agent/${name}`;
  const dst = `spike/forge-${name}`;
  const sha = await git(forge, ["rev-parse", src]);
  const lease = state.projected[dst] ?? ""; // "" = expect the ref to not exist
  if (lease === sha) {
    log("projection", "noop", { branch: dst, sha });
  } else {
    try {
      await git(forge, ["push", `--force-with-lease=refs/heads/${dst}:${lease}`, REMOTE, `${sha}:refs/heads/${dst}`]);
      log("projection", "pushed", { branch: dst, from: lease || null, to: sha });
      state.projected[dst] = sha;
      writeFileSync(stateFile, JSON.stringify(state, null, 2));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/stale info|rejected|fetch first|non-fast-forward/.test(msg)) throw err;
      // Divergence: GitHub moved under us. Import, never overwrite.
      const remoteRef = await git(forge, ["ls-remote", REMOTE, `refs/heads/${dst}`]);
      if (!remoteRef) {
        // A human deleted the projected branch: treat as "closed by human", never resurrect silently.
        log("projection", "deleted-upstream", { branch: dst, expected: lease });
        return { status: "deleted-upstream", sha };
      }
      await git(forge, ["fetch", REMOTE, `+refs/heads/${dst}:refs/forge/inbound/${name}`]);
      const theirs = await git(forge, ["rev-parse", `refs/forge/inbound/${name}`]);
      if (theirs === sha) {
        // A concurrent projector already pushed the same SHA — converge, not divergence.
        log("projection", "lease-race-converged", { branch: dst, sha });
        const s = loadState(stateFile);
        s.projected[dst] = sha;
        writeFileSync(stateFile, JSON.stringify(s, null, 2));
        await ensurePr({ dst, base, name, sha, state: s, stateFile, log });
        return { status: "projected", sha };
      }
      const humanCommits = (await git(forge, ["log", "--format=%h %an: %s", `${lease || sha}..${theirs}`])).split("\n").filter(Boolean);
      log("projection", "diverged", { branch: dst, expected: lease, github: theirs, forge: sha, humanCommits });
      return { status: "diverged", theirs, sha };
    }
  }
  await ensurePr({ dst, base, name, sha, state, stateFile, log });
  return { status: "projected", sha };
}

export async function ensurePr({ dst, base, name, sha, state, stateFile, log }) {
  const owner = GH_REPO.split("/")[0];
  // Idempotency: look up by head before creating. Cached number avoids a search call.
  let number = state.prs[dst];
  if (!number) {
    const open = await gh([`repos/${GH_REPO}/pulls?head=${owner}:${dst}&state=open`]);
    number = open?.[0]?.number;
  }
  const body = `Projected from Agent Forge (spike 001).\n\nforge ref: \`agent/${name}\` @ \`${sha.slice(0, 12)}\``;
  if (number) {
    await gh(["-X", "PATCH", `repos/${GH_REPO}/pulls/${number}`, "-f", `body=${body}`]);
    log("pr", "refreshed", { number, sha });
  } else {
    try {
      const pr = await gh(["-X", "POST", `repos/${GH_REPO}/pulls`, "-f", `title=[spike] forge projection ${name}`,
        "-f", `head=${dst}`, "-f", `base=${base}`, "-f", `body=${body}`, "-F", "draft=true"]);
      number = pr.number;
      log("pr", "created", { number, sha });
    } catch (err) {
      // A concurrent projector may have created it between lookup and create (422 "already exists").
      // gh puts the 422 body on stdout; err.message only says "Validation Failed".
      const msg = `${err instanceof Error ? err.message : String(err)} ${err?.stdout ?? ""}`;
      if (!/already exists/.test(msg)) throw err;
      const open = await gh([`repos/${GH_REPO}/pulls?head=${owner}:${dst}&state=open`]);
      number = open?.[0]?.number;
      log("pr", "create-race-adopted", { number });
    }
  }
  const fresh = loadState(stateFile);
  fresh.prs[dst] = number;
  writeFileSync(stateFile, JSON.stringify(fresh, null, 2));
  return number;
}
