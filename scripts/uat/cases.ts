// UAT cases — self-provisioning, self-asserting. See docs/uat/adr-036-effect-intent.md.
import {
  P, mk, CaseResult, poll, sleep, botReviews, noDupMax, botCommentsSince,
  stageFixturePR, pushFixContent, PARTIAL_FIX, FULL_FIX, postComment, cleanup, ghJson, sh,
  stageMultiFilePR, pushMfAFix,
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
    // ISOLATE the mention path (see docs/uat S12): creating an issue ALSO fires the issue-research
    // automation (on open), which confounds a mention burst (double intents). Phase 1: create the N
    // issues WITHOUT mentions and let their issue-research settle. Phase 2: fire the N mentions as the
    // burst, and count ONLY replies posted after the mention timestamp.
    for (let n = 1; n <= N; n++) {
      const q = qs[(n - 1) % qs.length];
      const url = sh(`gh issue create --repo ${P.REPO} --title ${JSON.stringify(`Question about the codebase [${P.RUN_ID}-${n}]`)} --body ${JSON.stringify(`Could someone help me understand this? ${q} (I'll follow up with a mention.)`)}`);
      issues.push(Number(url.match(/(\d+)\s*$/)?.[1]));
    }
    // Wait for the issue-research automation to SETTLE (each issue got its research reply) before the
    // mention burst — a fixed sleep is too short when research is slow / the worker is concurrency-1.
    // Bounded by the settle window; on a throughput-limited pilot this (and the whole case) is slow by
    // design — size UAT_SETTLE_TRIES/MS to the plane. Isolating research first keeps the mention count clean.
    await poll(
      () => issues.filter((iu) => botCommentsSince(iu, new Date(0).toISOString()).length >= 1).length,
      (c) => c === N,
      P.SETTLE_TRIES + 8,
    );
    await sleep(5_000);
    const mentionAt = new Date(Date.now() - 3_000).toISOString();
    for (let n = 0; n < N; n++) postComment(issues[n], `@${P.BOT_HANDLE} ${qs[n % qs.length]}`);
    r.evidence = { issues, N, mentionAt };
    const answered = await poll(
      () => issues.filter((iu) => botCommentsSince(iu, mentionAt).length >= 1).length,
      (c) => c === N,
      P.SETTLE_TRIES + 8,
    );
    if (answered === N) return pass(r, `all ${N} mention-burst replies landed (no starvation)`);
    return fail(r, `burst reliability: only ${answered}/${N} mention replies within window — ${N - answered} unanswered (see docs/uat S12: over-capacity work queues and never drains)`);
  } catch (e: any) { return fail(r, `error: ${e.message}`); }
  finally { for (const i of issues) cleanup({ issues: [i] }); }
}

// S15 (BUG-EXEC-02 regression guard): multi-file re-review must still block on a defect in an
// UNTOUCHED file. Opened PR = mf-a (off-by-one) + mf-b (secret-log), both flagged. Synchronize =
// partial fix of mf-a ONLY (commit does not touch mf-b). A re-review that lacks the base delta
// sees only the latest commit (mf-a, now clean) and can FALSE-APPROVE, missing mf-b. Correct
// behavior: still CHANGES_REQUESTED, naming mf-b. PRE base-fetch-fix this FAILS (the false-approve
// / missed-delta is the observed baseline); POST-fix this PASSES. Permanent guard against the
// diff-gap reintroducing. See docs/uat/adr-036-effect-intent.md "BUG-EXEC-02 RE-RUN TEST DESIGN".
export async function S15(): Promise<CaseResult> {
  const r = mk("S15", "multi-file partial-fix re-review must still block on the untouched-file defect (BUG-EXEC-02 guard)");
  let f;
  try {
    f = stageMultiFilePR("s15");
    r.evidence = { pr: f.pr, openedSha: f.sha };
    // opened → expect CR naming both defects (both files are new in the single PR commit)
    const opened = await poll(() => botReviews(f.pr),
      (rs) => rs.some((x) => x.commit_id === f.sha && (x.state === "CHANGES_REQUESTED" || x.state === "APPROVED" || x.state === "COMMENTED")));
    const openedV = opened.find((x) => x.commit_id === f.sha);
    (r.evidence as any).openedVerdict = openedV?.state ?? "none";
    if (openedV?.state !== "CHANGES_REQUESTED")
      r.reasons.push(`NOTE: opened verdict was ${openedV?.state ?? "none"} (expected CR on both defects) — the guard is the synchronize assertion below`);

    // synchronize: partial-fix mf-a ONLY; mf-b's secret-log remains, and this commit does not touch mf-b
    const sha2 = pushMfAFix(f);
    (r.evidence as any).partialHead = sha2;
    const revs2 = await poll(() => botReviews(f.pr), (rs) => rs.some((x) => x.commit_id === sha2 && !x.dismissed_at));
    const v2 = revs2.filter((x) => x.commit_id === sha2 && !x.dismissed_at);
    const verdict = v2.map((x) => x.state).sort().join("+") || "none";
    const cr2 = v2.filter((x) => x.state === "CHANGES_REQUESTED");
    // MECHANISM guard (learned 2026-07-21): the agent ADMITS in the body when it could not compute the
    // base diff ("origin/main is not present", "could not compute git diff origin/main...HEAD"). A CR that
    // names mf-b while ALSO admitting the diff failed caught mf-b by CONTENT-READ LUCK (reading mf-b.ts at
    // HEAD), NOT via base...HEAD — that is a FALSE-PASS of this guard (observed on PR#30 when the deploy was
    // ineffective). A TRUE mechanism pass = CR names mf-b AND the body does NOT admit the diff failed.
    const diffFailed = (b: string) => /could not compute|origin\/main is not present|not present in this clone|not present locally|base ref.*(unobtainable|cannot|fails)|git fetch.*(timed out|blocked)|no token/i.test(b);
    const crNamingB = cr2.filter((x) => /mf-b|logkey|console\.log|secret|api key/i.test(x.body));
    const mechanismProven = crNamingB.filter((x) => !diffFailed(x.body));
    (r.evidence as any).partialVerdict = verdict;
    (r.evidence as any).catchesMfB = crNamingB.length >= 1;
    (r.evidence as any).baseDiffAdmittedFailed = crNamingB.some((x) => diffFailed(x.body));
    (r.evidence as any).mechanismProven = mechanismProven.length >= 1;

    if (mechanismProven.length >= 1)
      return pass(r, `re-review blocked on the untouched-file defect (mf-b) via a WORKING base diff — verdict ${verdict}`,
        "BUG-EXEC-02 base-diff mechanism PROVEN: blocking review names mf-b AND does not admit a diff failure (base...HEAD resolved)");
    if (crNamingB.length >= 1)
      return fail(r, `MECHANISM NOT PROVEN — false-pass guarded: re-review named mf-b but the CR body ADMITS the base diff failed (origin/main absent)`,
        "mf-b was caught by CONTENT-READ luck (reading mf-b.ts at HEAD), NOT base...HEAD. S15 outcome green / mechanism red — BUG-EXEC-02 still open. This is exactly the false-pass the mechanism bar guards against.");

    // Not a correct still-CR → the false-approve / missed-delta is OBSERVED. This is the PRE-FIX baseline (expected FAIL).
    const mode = verdict.includes("APPROVED") ? "FALSE-APPROVE (blessed a PR whose mf-b secret-log is unaddressed)"
      : cr2.length >= 1 ? "CR-but-did-not-name-mf-b (missed the untouched-file defect)"
      : `no-block (verdict ${verdict})`;
    return fail(r, `BUG-EXEC-02 OBSERVED at re-review: ${mode}`,
      "PRE-FIX baseline: the base-less agent could not see mf-b as part of base...HEAD → missed the untouched-file defect. Expected to FLIP to PASS once the worker base-fetch fix lands.");
  } catch (e: any) { return fail(r, `error: ${e.message}`); }
  finally { if (f) cleanup(f); }
}

// Inline-thread-surface cases: exist as self-reporting SKIPPED.
export const phase2 = (): CaseResult[] => (["S10", "S11", "S13", "S14"] as const).map((id) => {
  const r = mk(id, "phase-2 surface (inline threads / resolve / stale-guard / one-review-object)");
  // STATUS (2026-07-21): REVIEW_SINGLE_WRITER is LIVE and PROVEN (RUN 4 swaccept5/PR#27: one-review-object
  // + supersede-dismiss verified across S1-S3 — S14/S13 substance is largely covered there). But S10/S11
  // test INLINE review threads (line comments / reply-then-resolve), which are gated on a SEPARATE flag,
  // REVIEW_POST_INLINE_COMMENTS. PR#27 posted 0 inline comments (findings folded into the review body),
  // so the inline surface is NOT live — these cannot be validated yet and are NOT force-passed by the
  // single-writer flip. Wire them as real cases once REVIEW_POST_INLINE_COMMENTS is enabled.
  // See "PHASE-2 ACCEPTANCE PLAN" + "RUN 4" in docs/uat/adr-036-effect-intent.md.
  return skip(r, "gated on REVIEW_POST_INLINE_COMMENTS (inline-thread surface), a SEPARATE flag from the now-live REVIEW_SINGLE_WRITER; PR#27 posted 0 inline comments so the surface is off. NOT force-passed by the single-writer flip. See RUN 4 in docs/uat/adr-036-effect-intent.md.");
});
