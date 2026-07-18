# UAT Suite — Automata platform (ADR-036 effect-intent parity)

A **durable, re-runnable** acceptance suite for the Automata review/mention agent. It re-validates
that the product path (webhook → automation → dispatch → agent-run → GitHub effect) reproduces the
orch-agents baseline behavior. Run it: at any time to re-validate functionality, at every customer
onboarding, and after the phase-2 single-writer emit_review integration lands.

The cases live in [`adr-036-effect-intent.md`](./adr-036-effect-intent.md). This file is the
**preamble**: parameters, preflight, conventions. Read it first, run the preflight, then execute cases.

> Provenance: distilled from the live parity run recorded in `docs/triage/UAT-VALIDATION-MATRIX.md`
> (2026-07-18). Every recipe here was actually executed; the matrix has the raw evidence.

---

## Parameters (set these once per run)

The recipes are parameterized so they run on ANY repo/plane, not this week's PR numbers.

```bash
export REPO="be-automata/automata"        # target repo (owner/name)
export BASE="main"                        # base branch for fixture PRs
export BOT_LOGIN="automata-ai-bot[bot]"   # the bot's GitHub *posting* login (reviews/comments author)
export BOT_HANDLE="automata-ai-bot"       # the @-mention handle = NEXT_PUBLIC_GITHUB_APP_NAME (MAY differ from BOT_LOGIN)
export WORKER_URL="https://automata-www.dark-water-9247.workers.dev"  # deployed www (daemonCallbackUrl target)
export HATCHET_PG="automata-hatchet-postgres-1"  # docker container for the pilot Hatchet OLAP (run-id lookup)
```

> **`BOT_HANDLE` vs `BOT_LOGIN` matters.** Mentions must use `@${BOT_HANDLE}` (matched by
> `isAppMentioned` against `NEXT_PUBLIC_GITHUB_APP_NAME`, a build-time inlined value). It CAN differ
> from the bot's posting login. On this pilot both are `automata-ai-bot`, but that required a deploy
> that inlined `NEXT_PUBLIC_GITHUB_APP_NAME=automata-ai-bot`. If mentions silently no-op, verify this
> first (see preflight).

---

## Preflight (run BEFORE any case — these are the exact things that bit us)

A green preflight is required; a red item means cases will silently no-op or void, not fail loudly.

1. **Plane health**
   ```bash
   curl -s -o /dev/null -w "tunnel %{http_code}\n" https://hatchet.beautomata.com/   # expect 200
   curl -s "$WORKER_URL/" | grep -oq "$BOT_HANDLE" && echo "www: BOT_HANDLE inlined OK" || echo "www: BOT_HANDLE MISSING — mentions will no-op"
   docker exec "$HATCHET_PG" psql -U hatchet -d hatchet -tAc "select 1" >/dev/null && echo "hatchet OLAP reachable" || echo "OLAP DOWN"
   ```
   Also confirm (operator/boot-coder side): the **worker is registered + ACTIVE** (action listener
   connected). A dead worker → triggers hit `SCHEDULING_TIMED_OUT` = **infra-void, re-fire** (not case evidence).

2. **Automations configured on `$REPO`** — dispatch is per-repo automation-gated; ZERO configured =
   webhook 200 but silent no-op. Confirm all three exist (via the app / operator — they live in Neon,
   not locally queryable):
   - a **pull_request** review automation (open+update, all-authors, enabled) — for S1/S2/S3.
   - a **github_mention** automation (all-authors, enabled) — for S4–S9, S12.
   - (issue automation optional.)

3. **Mentioner identity** — the GitHub account you mention/act FROM must be **OAuth-linked to a
   platform user** (else `getUsersToTriggerTasks=0` → "No users to create tasks for mention" → silent
   no-op). Onboarding checklist item: every user must OAuth-link their GitHub.

4. **GITHUB_BOT_LOGIN** runtime secret set to `$BOT_LOGIN` (the reconciler's bot-identity match).

**Gate disambiguation** (if a mention doesn't dispatch, a `wrangler tail` on the www worker tells you which gate):
| tail log line | gate | fix |
|---|---|---|
| `does not mention the app` | wrong handle | use `@${BOT_HANDLE}`; verify `NEXT_PUBLIC_GITHUB_APP_NAME` |
| `No users to create tasks for mention` | mentioner not linked | OAuth-link the acting GitHub account |
| `No github access token found for user` | mention-path token seam | needs App-installation token fallback (a55dc7a class) |
| `Found N users to trigger tasks` + `dispatching agent-run` | green | — |

---

## Conventions

- **Throwaway fixtures**: branch `uat/adr036-<slug>-<rand>`; fixture code under `scripts/uat/`
  (outside `src/`, never breaks lint/tsc). NEVER merge; clean up with
  `gh pr close <n> --delete-branch` and `gh issue close <n>`. NEVER delete the repo.
- **Push convention (LOAD-BEARING)**: push fixture branches with an **explicit refspec** and verify:
  ```bash
  git push origin "HEAD:refs/heads/$BR"
  git ls-remote origin "refs/heads/$BR"   # branch exists
  git ls-remote origin refs/heads/$BASE   # $BASE unchanged
  ```
  Do NOT `git push -u origin <branch>` from a worktree branched off `origin/$BASE` — on this repo
  `push.default=upstream` + the shared-main checkout means that pushes to `refs/heads/main` (it once
  pushed a fixture straight onto main). Always the explicit `HEAD:refs/heads/<branch>` form.
- **Timing**: a run takes ~30–150s after the trigger (agent + inference latency). After each trigger:
  `sleep ~50s`, then poll every ~25s up to ~6 min before declaring a step failed.
- **Run-id lookup** (OLAP; api/runs is behind Cloudflare Access):
  ```bash
  docker exec "$HATCHET_PG" psql -U hatchet -d hatchet -tAc \
    "select external_id, readable_status, to_char(inserted_at,'HH24:MI:SS') from v1_tasks_olap \
     where inserted_at > now() - interval '5 min' order by inserted_at desc limit 5;"
  ```
- **`dup_reconciled` telemetry** lives in the www Worker log (`wrangler tail`), line
  `[review-reconciler] dup_reconciled {prNumber, keepId, dupReconciled, actionableCount}` — the
  authoritative evidence that the interim reconciler fired.

### The no-duplicate invariant (assert after EVERY review step)
At most ONE non-dismissed **blocking** verdict per commit. `COMMENTED` reviews are informational and
cannot be dismissed — audit on `APPROVED`/`CHANGES_REQUESTED` only:
```bash
gh api "repos/$REPO/pulls/<PR>/reviews" \
  --jq "[.[]|select(.user.login==\"$BOT_LOGIN\" and .dismissed_at==null and (.state==\"APPROVED\" or .state==\"CHANGES_REQUESTED\"))] \
        | group_by(.commit_id) | map({commit:.[0].commit_id[0:8],count:length,states:map(.state)})"
# every commit's count MUST be 1. A 2 at any commit is the rollback trigger.
```

---

## Fixture: a PR with real defects (used by S1/S2/S3/S6/S7)

`scripts/uat/parity-fixture.ts` (seeded defects the reviewer must catch):
```ts
/** Validated, safe. */                                   // false attestation (review bait)
export function isAdult(age: number): boolean {
  return age > 18; // BUG: should be >= 18                // correctness: off-by-one
}
export function logKey(k: string): void {
  console.log("API key:", k); // SECURITY: logs a secret  // security: secret to console
}
```
Stage it (explicit-refspec push + verify):
```bash
RAND=$(date +%s | tail -c 6); BR="uat/adr036-$RAND"
git fetch origin "$BASE"; MAIN_BEFORE=$(git rev-parse origin/$BASE)
git worktree add --detach /tmp/wt-uat "origin/$BASE"; cd /tmp/wt-uat
mkdir -p scripts/uat; cat > scripts/uat/parity-fixture.ts <<'EOF'
# (contents above)
EOF
git add scripts/uat/parity-fixture.ts && git commit -m "uat: ADR-036 parity fixture (do not merge)"
git push origin "HEAD:refs/heads/$BR"
[ "$(git ls-remote origin refs/heads/$BASE | cut -f1)" = "$MAIN_BEFORE" ] && echo "BASE unchanged OK" || echo "BASE CHANGED — ABORT"
PR=$(gh pr create --repo "$REPO" --base "$BASE" --head "$BR" --title "UAT: ADR-036 (do not merge)" --body "throwaway" | grep -oE '[0-9]+$')
```

---

## Scorecard shape

| case | path | invariant | last verdict (2026-07-18) |
|---|---|---|---|
| S1 | review | opened → CHANGES_REQUESTED, no-dup | PASS (via interim reconciler) |
| S2 | review | partial-fix → still-CR at new HEAD, no-dup | PASS |
| S3 | review | full-fix → APPROVE + dismiss prior | PASS (supersede-dismiss proven) |
| S4 | mention | answer → one reply | PASS (reply-to marker gap) |
| S5 | mention | re-review deduped → still replies | PASS |
| S6 | mention | code-fix → bot commit + reply | PASS |
| S7 | command | `/request-changes` → CR via command path | PASS |
| S8 | command | verdict upgrade dismisses prior APPROVED | PASS |
| S9 | mention | unknown `/review` → some response | PASS |
| S12 | mention | burst reliability: N mentions → ALL N answered, one run per issue | FAIL — neutral re-run: 3 runs for 4 mentions, 2 collapse onto one issue, 3/4 unanswered (concurrency mis-routing) |
| S10, S11, S13, S14 | phase-2 | inline threads / resolve / stale-guard / one-review-object | PARKED (phase-2 surface) |

**Known-gaps carried** (not FAILs; upgrade pointers in each case):
- **INTERIM-RECONCILER**: no-dup is enforced *eventually* by a www-side post-run reconciler (dismiss
  extras / supersede on verdict change), NOT by a structural single-writer. A brief 2-review window
  can exist before reconciliation. Durable close = phase-2 single-writer emit_review integration.
- **Reply marker**: mention replies tag the author via `@mention`, not the OLD `reply-to:<comment-id>`
  marker; redelivery-dedup mechanism differs (unverified).
