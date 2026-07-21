// Self-contained UAT harness — shared library.
// Runtime: node 22 + tsx, `gh` CLI authenticated (GitHub-as-record for assertions),
// optional `docker`/`wrangler` for richer evidence (degrade to EVIDENCE-PARTIAL when absent).
// Doc cross-reference: docs/uat/adr-036-effect-intent.md (case narratives + rubrics).

import { execSync } from "node:child_process";

// ---------- params (env-overridable; sane pilot defaults) ----------
export const P = {
  REPO: process.env.REPO ?? "be-automata/automata",
  BASE: process.env.BASE ?? "main",
  BOT_LOGIN: process.env.BOT_LOGIN ?? "automata-ai-bot[bot]",
  BOT_HANDLE: process.env.BOT_HANDLE ?? "automata-ai-bot",
  WORKER_URL: process.env.WORKER_URL ?? "https://automata-www.dark-water-9247.workers.dev",
  HATCHET_PG: process.env.HATCHET_PG ?? "automata-hatchet-postgres-1",
  RUN_ID: process.env.UAT_RUN_ID ?? `r${Date.now().toString(36).slice(-6)}`, // suffix so repeat/parallel runs never collide
  SETTLE_TRIES: Number(process.env.UAT_SETTLE_TRIES ?? 14), // ~6 min at 25s
  SETTLE_MS: Number(process.env.UAT_SETTLE_MS ?? 25_000),
};

// ---------- result model ----------
export type Status = "PASS" | "FAIL" | "BLOCKED" | "SKIPPED" | "EVIDENCE-PARTIAL";
export interface CaseResult {
  id: string;
  title: string;
  status: Status;
  reasons: string[];
  evidence: Record<string, unknown>;
  started: string;
  ended?: string;
}
export const mk = (id: string, title: string): CaseResult => ({
  id, title, status: "BLOCKED", reasons: [], evidence: {}, started: new Date().toISOString(),
});

// ---------- shell / gh helpers ----------
export function sh(cmd: string, opts: { allowFail?: boolean } = {}): string {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e: any) {
    if (opts.allowFail) return "";
    throw new Error(`shell failed: ${cmd}\n${e.stderr || e.message}`);
  }
}
export const has = (bin: string) => sh(`command -v ${bin} || true`, { allowFail: true }) !== "";

// gh api with a jq filter; returns raw string
export const ghq = (path: string, jq: string) =>
  sh(`gh api ${path} --jq ${JSON.stringify(jq)}`, { allowFail: true });
// gh api returning parsed JSON (no jq)
export function ghJson<T = any>(path: string): T | null {
  const out = sh(`gh api ${path}`, { allowFail: true });
  try { return out ? JSON.parse(out) : null; } catch { return null; }
}
// post a comment on an issue/PR, return the comment id (CID)
export const postComment = (num: number, body: string): string =>
  sh(`gh api repos/${P.REPO}/issues/${num}/comments -f body=${JSON.stringify(body)} --jq .id`);

// ---------- OLAP (best-effort; null => EVIDENCE-PARTIAL) ----------
export function olap(sql: string): string | null {
  if (!has("docker")) return null;
  const out = sh(
    `docker exec ${P.HATCHET_PG} psql -U hatchet -d hatchet -tAc ${JSON.stringify(sql)}`,
    { allowFail: true },
  );
  return out === "" ? null : out;
}
export const recentRuns = () =>
  olap(`select external_id||' '||readable_status from v1_tasks_olap where inserted_at > now() - interval '6 min' order by inserted_at desc limit 6;`);

// ---------- polling ----------
export async function poll<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean,
  tries = P.SETTLE_TRIES, ms = P.SETTLE_MS): Promise<T> {
  let last!: T;
  for (let i = 0; i < tries; i++) {
    last = await fn();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, ms));
  }
  return last;
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- reviews / no-dup ----------
export interface Review { id: number; state: string; commit_id: string; dismissed_at: string | null; user: { login: string }; body: string; submitted_at: string; }
export const botReviews = (pr: number): Review[] =>
  (ghJson<Review[]>(`repos/${P.REPO}/pulls/${pr}/reviews`) ?? []).filter((r) => r.user?.login === P.BOT_LOGIN);
// count of non-dismissed blocking verdicts per commit (the no-dup invariant); returns max count
export function noDupMax(pr: number): { max: number; perCommit: Record<string, string[]> } {
  const rs = botReviews(pr).filter((r) => !r.dismissed_at && (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED"));
  const perCommit: Record<string, string[]> = {};
  for (const r of rs) (perCommit[r.commit_id] ??= []).push(r.state);
  const max = Object.values(perCommit).reduce((m, a) => Math.max(m, a.length), 0);
  return { max, perCommit };
}
export const botCommentsSince = (num: number, sinceISO: string): any[] =>
  (ghJson<any[]>(`repos/${P.REPO}/issues/${num}/comments`) ?? [])
    .filter((c) => c.user?.login === P.BOT_LOGIN && c.created_at > sinceISO);

// ---------- git fixture staging (explicit-refspec push; verify BASE unchanged) ----------
const FIXTURE = `/** Validated, safe. */
export function isAdult(age: number): boolean {
  return age > 18; // BUG: should be >= 18
}
export function logKey(k: string): void {
  console.log("API key:", k); // SECURITY: logs a secret
}
`;
export interface Fixture { pr: number; branch: string; sha: string; wt: string; file: string; }
export function stageFixturePR(slug: string): Fixture {
  const branch = `uat/adr036-${slug}-${P.RUN_ID}`;
  const file = "scripts/uat/fixtures/parity-fixture.ts";
  const wt = `/tmp/uat-wt-${slug}-${P.RUN_ID}`;
  sh(`git -C . fetch origin ${P.BASE} --quiet`, { allowFail: true });
  const baseBefore = sh(`git ls-remote origin refs/heads/${P.BASE}`).split(/\s+/)[0];
  sh(`rm -rf ${wt}; git worktree add --detach ${wt} origin/${P.BASE} --quiet`);
  sh(`mkdir -p ${wt}/scripts/uat/fixtures`);
  execSync(`cat > ${wt}/${file}`, { input: FIXTURE });
  sh(`git -C ${wt} add -f ${file}`); // -f: fixture path is gitignored on main; force onto the throwaway branch
  // NEUTRAL framing (see docs/uat pitfall): the bot reads commit msg + PR title/body as context;
  // "UAT/test/do-not-merge/throwaway" language makes it soften/decline. Present a genuine code change.
  sh(`git -C ${wt} -c user.name=uat -c user.email=uat@local commit -q -m "Add isAdult age helper (${P.RUN_ID})"`);
  const sha = sh(`git -C ${wt} rev-parse HEAD`);
  sh(`git -C ${wt} push origin HEAD:refs/heads/${branch}`);
  const onOrigin = sh(`git ls-remote origin refs/heads/${branch}`).split(/\s+/)[0];
  const baseAfter = sh(`git ls-remote origin refs/heads/${P.BASE}`).split(/\s+/)[0];
  if (onOrigin !== sha) throw new Error(`branch push failed for ${branch}`);
  if (baseAfter !== baseBefore) throw new Error(`SAFETY: ${P.BASE} changed during fixture push — ABORT`);
  const url = sh(`gh pr create --repo ${P.REPO} --base ${P.BASE} --head ${branch} --title ${JSON.stringify(`Add isAdult age helper [${P.RUN_ID}]`)} --body ${JSON.stringify("Adds a small `isAdult(age)` helper and a `logKey` utility under scripts/uat/. Please review for correctness and any issues.")}`);
  const pr = Number(url.match(/(\d+)\s*$/)?.[1]);
  return { pr, branch, sha, wt, file };
}
// push a new content to the fixture branch (a synchronize)
export function pushFixContent(f: Fixture, content: string, msg: string): string {
  execSync(`cat > ${f.wt}/${f.file}`, { input: content });
  sh(`git -C ${f.wt} add -f ${f.file}`); // -f: fixture path is gitignored on main; force onto the throwaway branch
  sh(`git -C ${f.wt} -c user.name=uat -c user.email=uat@local commit -q -m ${JSON.stringify(msg)}`);
  sh(`git -C ${f.wt} push origin HEAD:refs/heads/${f.branch}`);
  return sh(`git -C ${f.wt} rev-parse HEAD`);
}
export const PARTIAL_FIX = `/** Validated, safe. */
export function isAdult(age: number): boolean {
  return age > 18; // BUG: should be >= 18
}
`; // console.log removed, off-by-one remains
export const FULL_FIX = `export function isAdult(age: number): boolean {
  return age >= 18;
}
`; // off-by-one fixed, attestation removed

// ---------- multi-file false-approve fixture (S15 / BUG-EXEC-02 regression guard) ----------
// Two files, each with a distinct defect. The synchronize fixes ONLY mf-a in a commit that does
// not touch mf-b — so a re-review that lacks the base delta (BUG-EXEC-02) sees only the latest
// commit (mf-a, now clean) and can FALSE-APPROVE, missing mf-b's still-present secret-log. With
// the base fetched, base...HEAD shows BOTH files and the review must still block on mf-b.
const MF_DIR = "scripts/uat/fixtures";
export const MF_A_DEFECTIVE = `export function isAdult(age: number): boolean {
  return age > 18; // BUG: off-by-one, should be >= 18
}
`;
export const MF_A_FIXED = `export function isAdult(age: number): boolean {
  return age >= 18;
}
`;
export const MF_B_DEFECTIVE = `export function logKey(k: string): void {
  console.log("API key:", k); // SECURITY: logs a secret
}
`;
// Stage a 2-file PR (mf-a + mf-b both defective) in one commit → opened review sees both.
export function stageMultiFilePR(slug: string): Fixture {
  const branch = `uat/adr036-${slug}-${P.RUN_ID}`;
  const wt = `/tmp/uat-wt-${slug}-${P.RUN_ID}`;
  sh(`git -C . fetch origin ${P.BASE} --quiet`, { allowFail: true });
  const baseBefore = sh(`git ls-remote origin refs/heads/${P.BASE}`).split(/\s+/)[0];
  sh(`rm -rf ${wt}; git worktree add --detach ${wt} origin/${P.BASE} --quiet`);
  sh(`mkdir -p ${wt}/${MF_DIR}`);
  execSync(`cat > ${wt}/${MF_DIR}/mf-a.ts`, { input: MF_A_DEFECTIVE });
  execSync(`cat > ${wt}/${MF_DIR}/mf-b.ts`, { input: MF_B_DEFECTIVE });
  sh(`git -C ${wt} add -f ${MF_DIR}/mf-a.ts ${MF_DIR}/mf-b.ts`);
  sh(`git -C ${wt} -c user.name=uat -c user.email=uat@local commit -q -m "Add age + key-logging helpers (${P.RUN_ID})"`);
  const sha = sh(`git -C ${wt} rev-parse HEAD`);
  sh(`git -C ${wt} push origin HEAD:refs/heads/${branch}`);
  const onOrigin = sh(`git ls-remote origin refs/heads/${branch}`).split(/\s+/)[0];
  const baseAfter = sh(`git ls-remote origin refs/heads/${P.BASE}`).split(/\s+/)[0];
  if (onOrigin !== sha) throw new Error(`branch push failed for ${branch}`);
  if (baseAfter !== baseBefore) throw new Error(`SAFETY: ${P.BASE} changed during fixture push — ABORT`);
  const url = sh(`gh pr create --repo ${P.REPO} --base ${P.BASE} --head ${branch} --title ${JSON.stringify(`Add age + key helpers [${P.RUN_ID}]`)} --body ${JSON.stringify("Adds isAdult(age) in mf-a.ts and logKey(k) in mf-b.ts under scripts/uat/fixtures. Please review both files for correctness and safety.")}`);
  const pr = Number(url.match(/(\d+)\s*$/)?.[1]);
  return { pr, branch, sha, wt, file: `${MF_DIR}/mf-a.ts` };
}
// Push a partial fix touching ONLY mf-a; mf-b's defect is left, and the commit does not touch mf-b.
export function pushMfAFix(f: Fixture): string {
  execSync(`cat > ${f.wt}/${MF_DIR}/mf-a.ts`, { input: MF_A_FIXED });
  sh(`git -C ${f.wt} add -f ${MF_DIR}/mf-a.ts`);
  sh(`git -C ${f.wt} -c user.name=uat -c user.email=uat@local commit -q -m "Fix isAdult off-by-one in mf-a"`);
  sh(`git -C ${f.wt} push origin HEAD:refs/heads/${f.branch}`);
  return sh(`git -C ${f.wt} rev-parse HEAD`);
}

// ---------- cleanup (idempotent) ----------
export function cleanup(f: Partial<Fixture> & { issues?: number[] }): void {
  if (f.pr) sh(`gh pr close ${f.pr} --repo ${P.REPO} --comment "Closing UAT artifact." --delete-branch`, { allowFail: true });
  for (const i of f.issues ?? []) sh(`gh issue close ${i} --repo ${P.REPO}`, { allowFail: true });
  if (f.wt) sh(`git worktree remove ${f.wt} --force`, { allowFail: true });
  sh(`git worktree prune`, { allowFail: true });
}

// ---------- preflight (as code; hard-stop) ----------
export function preflight(): { ok: boolean; problems: string[]; notes: string[] } {
  const problems: string[] = [], notes: string[] = [];
  if (!has("gh")) problems.push("`gh` CLI not found / not authenticated");
  else if (sh(`gh auth status 2>&1 || true`).includes("not logged")) problems.push("`gh` not authenticated");
  const html = sh(`curl -s ${P.WORKER_URL}/`, { allowFail: true });
  if (!html) problems.push(`www unreachable at ${P.WORKER_URL}`);
  else if (!html.includes(P.BOT_HANDLE))
    // NOT a hard-block: NEXT_PUBLIC_GITHUB_APP_NAME is used server-side (isAppMentioned on the Worker)
    // and is not reliably present in the landing-page HTML/chunks. The FIRST mention case validates the
    // handle functionally (dispatch, or a loud FAIL with the gate-disambiguation table). Verify via a
    // `wrangler tail`: "does not mention the app" = wrong handle.
    notes.push(`could not confirm BOT_HANDLE '${P.BOT_HANDLE}' in the www landing bundle (it is primarily a server-side value) — mention cases will validate it functionally; if they no-op, use the gate-disambiguation table (handle vs identity vs token)`);
  const tun = sh(`curl -s -o /dev/null -w '%{http_code}' https://hatchet.beautomata.com/ || true`, { allowFail: true });
  if (tun !== "200") notes.push(`tunnel hatchet.beautomata.com returned ${tun || "n/a"} (worker dispatch may be down → SCHEDULING_TIMED_OUT is infra-void, re-fire)`);
  if (!has("docker") || recentRuns() === null) notes.push("OLAP not reachable — run-id evidence degrades to EVIDENCE-PARTIAL (assertions still use GitHub-as-record)");
  if (!has("wrangler")) notes.push("wrangler not available — dup_reconciled telemetry unavailable; reconciler evidence via GitHub end-state only");
  // repo automations can't be checked from here (Neon) — documented preflight step
  notes.push("MANUAL preflight: confirm pull_request + github_mention automations exist on the repo, and the acting GitHub user is OAuth-linked (else silent no-op).");
  return { ok: problems.length === 0, problems, notes };
}
