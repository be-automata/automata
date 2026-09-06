# Epic refinement report — #152 (Stage B remainder)

- Run date: 2026-09-05 · Mode: full · Integration branch SHA: `main` e2716a4
- Operator: /dev-epic-refinement (harness) · Hardening engine: n/a — this repo's tracker is GitHub issues, so the rewrite mechanics (Jira `editJiraIssue`) do not apply; the hardened tickets were created as new GitHub issues with the SDD story template, and #152's body was left untouched as the historical record.

## Verdict

Bullet-proof for the two executable tickets: #183 and #184 are self-contained, reality-checked
against `main` e2716a4 with `file:line` evidence, ADR-anchored, linked, and each carries its
Open Decisions with an owner and a default. What remains outside them, by decision:

- The memory ceiling is **deferred** (no ticket): nothing exists today (no ulimit/RLIMIT/watchdog
  in worker, deploy or daemon), macOS has no cgroups, and the hard cap arrives with a
  containerized/`systemd` topology under the execution-plane proposal. Recorded in the #152
  comment and in the ADR-007 amendment text that #183 will land.
- #152's original Stage 1/Stage 2 sections are void (2026-09-02 premise correction: the
  production agent is a host process group, not a container). Stage A shipped in #177.

## Ticket map (before → after)

| Key | Type | Status | Reality verdict | Rewritten | Notes |
|---|---|---|---|---|---|
| #152 | Story (child of epic #125) | Open | Stage 1/2 **contradicts-code**; Stage A **exists** (#177) | No (comment added) | Stays open as the epic-level record; closes when #184 is live-proven |
| #183 | Story (new) | Open | T1 **net-new** (replaces `box-slot.ts`; retires `worker-2`) | Created | Kernel-released lock via stock `lockf`/`flock` helper child; ADR-007 amendment + invariants ride in its PR |
| #184 | Story (new) | Open | T2 **net-new**; sudoers kill grant **exists** | Created | Blocked by #183; uid-wide `kill -9 -- -1` as the agent uid; `box.*` events + `box-budget.json` |
| memory ceiling | — | Deferred | **net-new, nothing exists** | Not created | Deferred 2026-09-05 by user decision |

## Link graph

GitHub has no typed links; relations are body lines plus the #152 task-list comment.

| From | Link | To | State |
|---|---|---|---|
| #183 | Blocks | #184 | NEW (bodies) |
| #183 | Blocks (partially) | #152 | NEW (comment task list) |
| #184 | Blocked by | #183 | NEW (title + body) |
| #184 | Closes | #152 | NEW (comment) |
| #183, #184 | Relates to | #125 (epic), #171 (worker unit tests absent from CI) | NEW (bodies) |
| #152 | Relates to | #165 (sibling, ADR-007) | existing (prior comment) |

Suspected-wrong existing links: none. Nothing deleted.

## Gaps resolved

- Created tickets: #183 (Stage B1 lock + one-worker topology), #184 (Stage B2 uid-scan reaper).
- api-contracts authored: none (no HTTP surface; module contracts live in the ticket bodies).
- ADR proposals (pending TL ratification, land with #183's PR — not committed by this run):
  - ADR-007 `## Amendment (2026-09-05, #152 Stage B)` items 1–5 (mechanism, topology,
    reclamation ≠ cancellation, signal seam, memory ceiling deferred) and a new
    `## Anti-deviation invariants` section I1–I6 — ADR-007 has none today although
    `docs/adr/README.md` requires one for composability-critical decisions.
  - ADR-007 status line upgrade; `docs/adr/README.md:15` cell; ADR-007 `:28-29` "agent container" →
    "agent process group"; ADR-002 `:545-546` wording.
- Doc-bug follow-ups folded into #183: `deploy/README.md:22-24` cites `GLOBAL_MAX_RUNS` in the
  wrong file; the plist/README claim that the engine's global cap serializes across both units
  is false (the key is per workflow); no `in_flight` drain check exists in any runbook.

## Auto-decisions (autonomous mode)

| # | Decision | Rationale | Recorded in |
|---|---|---|---|
| AD-1 | Tracker is GitHub; hardening = new issues + a comment on #152, never a rewrite of #152's body | The repo's tickets (#125, #152, #165, #171) are GitHub issues; no Jira project governs them; #152's body is the premise-correction history | this report |
| AD-2 | #183 OD-1 default = flock(2) via a stock `lockf` (darwin) / `flock` (linux) helper child | Zero dependencies; verified on the box that `lockf` runs the command only after the lock is held, that only the `lockf` pid holds the file, and that the kernel drops the lock when the command exits; `fs-ext` rejected on pnpm-10 build-script friction; socket-liveness fallback is sound only under a one-acquirer topology assumption | #183 OD-1 |
| AD-3 | #184 hard-stacks on #183 | Under `box-slot.ts` a stalled-but-live holder is reclaimed after 45 s → two holders → a uid-wide kill would SIGKILL a live run (ADR-007 Decision 5 violation) | #184 header, Dependencies |
| AD-4 | Memory ceiling deferred, no ticket | User decision 2026-09-05; nothing exists; macOS has no cgroups | #152 comment; ADR amendment item 5 |
| AD-5 | Reaper signal = run-scoped `box.*` log events + `box-budget.json`, not `scheduling-health.json` | The maintenance tick is engine-DB-gated and advisory-locked; a process-plane fact would vanish silently | #184 Scope 5 |
| AD-6 | Uid-wide `kill -9 -- -1` over per-pid kills | Kernel-bounded to the agent uid, excludes the caller, one kernel pass; stragglers surface as `residual` | #184 OD-1 |
| AD-7 | `alertableRecoveryLatencySeconds`: doc change only | Architect over tester: deleting it ripples into AC-5b and the runbook for no safety gain | #183 OD-2 |
| AD-8 | Boot uid scan is a try-lock that skips on busy, never blocks | Adversarial finding: an unbounded acquire would hang a boot silently behind an operator-launched second copy | #184 Scope 4, AC14 |
| AD-9 | Add `box-lock.test.ts` to the `worker-e2e` job line; Linux uid IT with a runner `useradd` (default include) | CI runs no worker unit tests (#171); these are the only CI-visible kernel proofs | #183 Scope 7; #184 OD-2 |
| AD-10 | Teardown settle is for count attribution, not safety | `kill(-1)` covers the daemon's pgid regardless; forbids "fixing" safety by lengthening it | #184 OD-3 |

## Escalations (Confusion Protocol)

One, raised by the preceding `/dev-execution` run on 2026-09-05: #152's remainder had no
executable spec and was parked on the one-worker topology decision, while the same-day
execution-plane proposal (Hetzner VM, systemd, counting slot) would resolve the pieces
differently. Options offered: refine first for the current box / execute Stage B now under
assumptions / defer to the VM move. **Answer: refine first** (current macOS/launchd box, memory
ceiling deferred). No further escalation was needed.

## Evidence

- Reality probes (read-only `Plan` agent + direct reads, `main` e2716a4): `box-slot.ts:39,129-130,150-184,214-222`;
  `workflow.ts:11,410,459-479,500,553,607,698-715`; `run-namespace.ts:32,45-63,93-102,139`;
  `hello/worker.ts:35,45,64-135`; `reclaim.ts:89-227`; `daemon-process.ts:210-221,327-402`;
  `spawn-as-user.ts:58-59,109-127,139-160`; `deploy/sudoers.d-automata:4-7,36,58`;
  `scheduling-health.ts:79-628`; `scheduling-maintenance.ts:35-74,172-175`;
  `definition.ts:20,31,47-52,150-156,171-172,180`; `deploy/README.md:7-25,84-138,218-246`;
  `com.automata.worker-2.plist:4-14`; `AGENT-UID-PROVISIONING.md:164-192,234-247,293-300`;
  `supersede.integration.test.ts:22,80-111,208,426-469`; `workflow-cleanup.test.ts:79,887-911`;
  `.github/workflows/ci.yml:83-146`; ADR-007 `:3,28-29,45-65`; ADR-002 `:227-259,541-548`.
- Architecture (harness `system-architect`): T1 PASS with mechanism substitution, T2 PASS
  stacked on T1; rulings 1–6 and the ADR-007 amendment draft are reproduced in the ticket bodies.
- Test planning (harness `tester`): 13 + 13 AC-linked cases, UAT U1–U7, loop-engineering blocks.
- Chain (ruflo `planner`): T1 → T2 stacked; four phases each, all ≤ 5 files; file-ownership map
  for the stacked window (T1 owns `workflow.ts`, both workflow tests, `hello/worker.ts`,
  `deploy/README.md`, ADR-007, `ci.yml` until merge).
- Adversarial review (pitfall #7): 0 BLOCK, 6 FIX, 8 NIT, 36 anchors spot-checked and holding;
  every FIX and the load-bearing NITs were applied before the issues were created.
  Box-verified: `man lockf` semantics, `lsof` on a live `lockf` helper, `kill -0 -- -1` parsing,
  `kill(2)` uid rules.
- FE evidence (gstack browse): n/a (no FE surface).
- Verify sweep: #183 and #184 re-fetched after creation/edit — 19 and 16 `##` sections, 42 and 43
  table rows rendered; #183 references #184 three times; the #152 comment posted once
  (idempotency check before posting).
