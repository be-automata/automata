// UAT cases — self-provisioning, self-asserting. See docs/uat/adr-036-effect-intent.md.
import {
  P, mk, CaseResult, poll, sleep, botReviews, noDupMax, botCommentsSince,
  stageFixturePR, pushFixContent, PARTIAL_FIX, FULL_FIX, postComment, cleanup, ghJson, sh,
} from "./lib";

const nowISO = () => new Date().toISOString();
const pass = (r: CaseResult, ...why: string[]) => { r.status = "PASS"; r.reasons.push(...why); return done(r); };
const fail = (r: CaseResult, ...why: string[]) => { r.status = "FAIL"; r.reasons.push(...why); return done(r); };
const partial = (r: CaseResult, ...why: string[]) => { r.status = "EVIDENCE-PARTIAL"; r.reasons.push(...why); return done(r); };
const skip = (r: CaseResult, ...why: string[]) => { r.status = "SKIPPED"; r.reasons.push(...why); return done(r); };
const done = (r: CaseResult) => { r.ended = nowISO(); return r; };

// S1-S3 share one fixture PR (opened → partial-fix → full-fix lifecycle).
export async function S1_S3(): Promise<CaseResult[]> {
  const r1 = mk("S1", "opened → CHANGES_REQUESTED (no-dup)");
  const r2 = mk("S2", "partial-fix → still CR at new HEAD");
  const r3 = mk("S3", "full-fix → APPROVE + dismiss prior");
  let f;
  try {
    f = stageFixturePR("s1s3");
    r1.evidence = { pr: f.pr, sha: f.sha };
    // S1: opened → CR
    const revs1 = await poll(() => botReviews(f.pr), (rs) => rs.some((x) => x.commit_id === f.sha && x.state === "CHANGES_REQUESTED"));
    const cr1 = revs1.filter((x) => x.commit_id === f.sha && x.state === "CHANGES_REQUESTED" && !x.dismissed_at);
    const nd1 = noDupMax(f.pr);
    if (cr1.length < 1) fail(r1, "no CHANGES_REQUESTED at HEAD after settle window");
    else if (nd1.max > 1) fail(r1, `no-dup VIOLATION: ${nd1.max} non-dismissed verdicts at a commit`, JSON.stringify(nd1.perCommit));
    else {
      const body = cr1[0].body.toLowerCase();
      const named = /off-by-one|>= ?18|age > 18/.test(body) && /console\.log|secret|api key/.test(body);
      pass(r1, `CHANGES_REQUESTED at HEAD, no-dup=${nd1.max}`, named ? "body names security+correctness" : "WARN: defects not clearly named (still PASS on verdict+no-dup)");
    }

    // S2: partial fix → still CR at new HEAD
    const sha2 = pushFixContent(f, PARTIAL_FIX, "uat S2: partial fix (remove console.log)");
    r2.evidence = { newHead: sha2 };
    const revs2 = await poll(() => botReviews(f.pr), (rs) => rs.some((x) => x.commit_id === sha2));
    const cr2 = revs2.filter((x) => x.commit_id === sha2 && x.state === "CHANGES_REQUESTED" && !x.dismissed_at);
    const nd2 = noDupMax(f.pr);
    if (cr2.length !== 1) fail(r2, `expected 1 non-dismissed CR at new HEAD, got ${cr2.length}`);
    else if (nd2.perCommit[sha2]?.length !== 1) fail(r2, `no-dup at new HEAD = ${nd2.perCommit[sha2]?.length}`);
    else {
      const b = cr2[0].body.toLowerCase();
      const acked = /fixed|resolved|removed/.test(b) && !/still.*console\.log|console\.log.*secret/.test(b);
      pass(r2, "still CHANGES_REQUESTED at new HEAD, no-dup=1", acked ? "fixed item acknowledged/not re-raised" : "WARN: fix-acknowledgement not detected");
    }

    // S3: full fix → APPROVE + dismiss prior
    const sha3 = pushFixContent(f, FULL_FIX, "uat S3: full fix (>=, remove attestation)");
    r3.evidence = { newHead: sha3 };
    const revs3 = await poll(() => botReviews(f.pr), (rs) => rs.some((x) => x.commit_id === sha3 && x.state === "APPROVED"));
    const appr = revs3.filter((x) => x.commit_id === sha3 && x.state === "APPROVED" && !x.dismissed_at);
    const lingeringCR = revs3.filter((x) => x.state === "CHANGES_REQUESTED" && !x.dismissed_at);
    if (appr.length !== 1) fail(r3, `expected APPROVED at HEAD, got ${appr.length}`);
    else if (lingeringCR.length !== 0) fail(r3, `${lingeringCR.length} prior CHANGES_REQUESTED NOT dismissed (supersede-dismiss failed)`);
    else pass(r3, "APPROVED at HEAD + all prior CR dismissed + 0 lingering blocking verdicts");
  } catch (e: any) {
    for (const r of [r1, r2, r3]) if (r.status === "BLOCKED") r.reasons.push(`error: ${e.message}`);
  } finally {
    if (f) cleanup(f);
  }
  return [r1, r2, r3];
}

// Generic mention → reply case.
async function mentionReplies(id: string, title: string, prNum: number, body: string): Promise<CaseResult> {
  const r = mk(id, title);
  const t = nowISO();
  try {
    const cid = postComment(prNum, body);
    r.evidence = { pr: prNum, cid };
    const replies = await poll(() => botCommentsSince(prNum, t), (c) => c.length >= 1);
    if (replies.length >= 1) return pass(r, `${replies.length} reply(ies) landed`, "known-gap: reply uses @mention not reply-to:<id> marker");
    return fail(r, "no bot reply within settle window (silent drop)");
  } catch (e: any) { return fail(r, `error: ${e.message}`); }
}

export const S4 = (pr: number) => mentionReplies("S4", "mention answer → one reply", pr, `@${P.BOT_HANDLE} what does the isAdult function do?`);
export const S9 = (pr: number) => mentionReplies("S9", "unknown /review → some response", pr, `@${P.BOT_HANDLE} /review`);

// S5: re-review deduped + still replies (needs a non-dismissed verdict at HEAD).
export async function S5(pr: number): Promise<CaseResult> {
  const r = mk("S5", "re-review deduped → still replies");
  const t = nowISO();
  try {
    const before = noDupMax(pr).max;
    if (before < 1) return skip(r, "precondition unmet: no non-dismissed verdict at HEAD (run S1/S3 first)");
    const cid = postComment(pr, `@${P.BOT_HANDLE} please re-review this PR`);
    r.evidence = { pr, cid, verdictsBefore: before };
    await sleep(P.SETTLE_MS);
    const replies = await poll(() => botCommentsSince(pr, t), (c) => c.length >= 1);
    const after = noDupMax(pr).max;
    if (after > before) return fail(r, `re-review NOT deduped: verdicts ${before}→${after}`);
    if (replies.length < 1) return fail(r, "deduped but reply silenced (mention-always-replies violated)");
    return pass(r, `verdict deduped (stayed ${after}), reply landed`);
  } catch (e: any) { return fail(r, `error: ${e.message}`); }
}

// S7: /request-changes command → CR verdict + no-dup + reply.
export async function S7(pr: number): Promise<CaseResult> {
  const r = mk("S7", "/request-changes command path → CR");
  const t = nowISO();
  try {
    const cid = postComment(pr, `@${P.BOT_HANDLE} /request-changes keep this blocked — do-not-merge fixture`);
    r.evidence = { pr, cid };
    const revs = await poll(() => botReviews(pr), (rs) => rs.some((x) => x.state === "CHANGES_REQUESTED" && !x.dismissed_at));
    const nd = noDupMax(pr);
    const cr = revs.filter((x) => x.state === "CHANGES_REQUESTED" && !x.dismissed_at);
    const reply = botCommentsSince(pr, t).length >= 1;
    if (cr.length < 1) return fail(r, "command did not produce a CHANGES_REQUESTED");
    if (nd.max > 1) return fail(r, `no-dup VIOLATION: ${nd.max}`);
    return pass(r, `command → CR, no-dup=${nd.max}`, reply ? "reply landed" : "note: reply not detected (ruleKey behind CF Access)");
  } catch (e: any) { return fail(r, `error: ${e.message}`); }
}

// S8: verdict upgrade over APPROVED (needs a non-dismissed APPROVED at HEAD).
export async function S8(pr: number): Promise<CaseResult> {
  const r = mk("S8", "verdict UPGRADE dismisses prior APPROVED");
  try {
    const apprBefore = botReviews(pr).filter((x) => x.state === "APPROVED" && !x.dismissed_at);
    if (apprBefore.length < 1) return skip(r, "precondition unmet: no non-dismissed APPROVED at HEAD (run S3 first)");
    const cid = postComment(pr, `@${P.BOT_HANDLE} /request-changes must not be approved while do-not-merge`);
    r.evidence = { pr, cid };
    const revs = await poll(() => botReviews(pr), (rs) => rs.some((x) => x.state === "CHANGES_REQUESTED" && !x.dismissed_at));
    const cr = revs.filter((x) => x.state === "CHANGES_REQUESTED" && !x.dismissed_at);
    const apprAfter = revs.filter((x) => x.state === "APPROVED" && !x.dismissed_at);
    const nd = noDupMax(pr);
    if (cr.length < 1) return fail(r, "upgrade did not post CHANGES_REQUESTED");
    if (apprAfter.length !== 0) return fail(r, `prior APPROVED NOT dismissed (${apprAfter.length} remain) — verdict swallowed`);
    if (nd.max > 1) return fail(r, `no-dup VIOLATION: ${nd.max}`);
    return pass(r, "CR posted, prior APPROVED dismissed, no-dup=1 (verdict-aware idempotency)");
  } catch (e: any) { return fail(r, `error: ${e.message}`); }
}

// S6: code-fix mention → bot commit + reply (needs an unfixed defect PR).
export async function S6(): Promise<CaseResult> {
  const r = mk("S6", "code-fix mention → bot commit + reply");
  let f;
  try {
    f = stageFixturePR("s6");
    const t = nowISO();
    const cid = postComment(f.pr, `@${P.BOT_HANDLE} please fix the off-by-one in ${f.file} — isAdult should use >= 18. Push the fix to this PR.`);
    r.evidence = { pr: f.pr, cid, headBefore: f.sha };
    const head = await poll(
      () => ghJson<any>(`repos/${P.REPO}/pulls/${f!.pr}`)?.head?.sha ?? f!.sha,
      (h) => h !== f!.sha,
      P.SETTLE_TRIES + 4,
    );
    if (head === f.sha) return fail(r, "PR HEAD did not advance (no bot fix commit)");
    const last = ghJson<any[]>(`repos/${P.REPO}/pulls/${f.pr}/commits`)?.slice(-1)[0];
    const botAuthored = (last?.commit?.author?.name ?? "").toLowerCase().includes("bot") ||
      (last?.author?.login ?? "") === P.BOT_LOGIN.replace("[bot]", "");
    const reply = botCommentsSince(f.pr, t).length >= 1;
    if (!botAuthored) return fail(r, `HEAD advanced but last commit not bot-authored (${last?.commit?.author?.name})`);
    return pass(r, `bot-authored fix commit (HEAD ${head.slice(0, 8)})`, reply ? "reply landed" : "note: reply not detected");
  } catch (e: any) { return fail(r, `error: ${e.message}`); }
  finally { if (f) cleanup(f); }
}

// S12: burst reliability — N near-simultaneous mentions → ALL N reply (no silent loss).
export async function S12(N = 4): Promise<CaseResult> {
  const r = mk("S12", "burst reliability: N mentions → ALL N reply");
  const issues: number[] = [];
  try {
    // PITFALL (see docs/uat S12): fixtures must NOT signal "test / do not action" — agents read
    // titles+bodies as context and correctly decline test-looking work, which looks like silent
    // failure. Fixtures must read as GENUINE user questions. RUN_ID is only a bracketed cleanup tag.
    const qs = [
      "what are the main packages in this repository and what does each one do?",
      "which package holds the GitHub webhook handling code?",
      "where does the agent-run worker live and what is its entry point?",
      "what database does the app use and where is the schema defined?",
      "how is authentication implemented in this codebase?",
    ];
    for (let n = 1; n <= N; n++) {
      const q = qs[(n - 1) % qs.length];
      const url = sh(`gh issue create --repo ${P.REPO} --title ${JSON.stringify(`Question about the codebase [${P.RUN_ID}-${n}]`)} --body ${JSON.stringify(`Could someone help me understand this? ${q}`)}`);
      const iu = Number(url.match(/(\d+)\s*$/)?.[1]);
      issues.push(iu);
      postComment(iu, `@${P.BOT_HANDLE} ${q}`);
    }
    r.evidence = { issues, N };
    const t0 = new Date(Date.now() - 5_000).toISOString();
    const answered = await poll(
      () => issues.filter((iu) => botCommentsSince(iu, t0).length >= 1).length,
      (c) => c === N,
      P.SETTLE_TRIES + 6,
    );
    if (answered === N) return pass(r, `all ${N} mentions replied (no silent loss)`);
    return fail(r, `burst reliability: only ${answered}/${N} replied — ${N - answered} silent (mid-run token revocation class; see docs/uat S12)`);
  } catch (e: any) { return fail(r, `error: ${e.message}`); }
  finally { for (const i of issues) cleanup({ issues: [i] }); }
}

// Phase-2-gated cases: exist as self-reporting SKIPPED.
export const phase2 = (): CaseResult[] => (["S10", "S11", "S13", "S14"] as const).map((id) => {
  const r = mk(id, "phase-2 surface (inline threads / resolve / stale-guard / one-review-object)");
  return skip(r, "phase-2-gated: requires the formal-review/inline-comment surface (review-package phase-2). See docs/uat/adr-036-effect-intent.md.");
});
