# ADR-005: Permission and posture controls are monotone floors — tighten-only

- **Status:** Accepted (2026-08-21) as the governing invariant for epic #70 Track P (#71–#74) and its
  successors #82 (per-trigger `permissionMode` floor) and #83 (per-sub-event granularity). The
  review-severity axis (`blockTolerance`) already ships; this ADR fixes the *shape* every current
  and future strictness control must take.
- **Date:** 2026-08-21
- **Context source:** `packages/shared/src/db/schema.ts:1423` (`blockTolerance` on
  `repo_review_settings`), `packages/review/src/review/severity-policy.ts` (`toleranceToPolicy`),
  `packages/review/src/settings/review-floor-resolver.ts` (`resolveApproveFloorPolicy` live-read),
  `apps/www/src/server-lib/remote-daemon-message.ts:138-149` (permissionMode seam). Benchmark:
  yc-software/qm `src/security/security-posture.ts` (a strict/auto/dangerous floor scopes can only
  tighten) — external validation of the tighten-only shape.
- **Deciders:** operator + 2026-08-21 architecture pass. Owner ruling (2026-08-20): the org floor
  governs **external-PR verdicts only**; the internal `ReviewGate` / `GATE_SEVERITY_POLICY` stays
  **per-repo** and is NOT dragged into the org lattice.
- **Relates to:** ADR-004 (`review` is the strictest value of the permission floor and is
  structurally pinned for PR-family events), ADR-006 (planes receive the resolved mode only). Tracks
  #70/#71/#72/#82/#83.
- **Supersedes / superseded by:** —

## Context

Two strictness axes exist: **review severity** (the lowest severity that blocks a merge) and
**permission mode** (`review`/`plan`/`allowAll`). Both are governed at multiple scopes (org, repo,
trigger, sub-event). The failure mode to design against is a lower scope *loosening* what a higher
scope required — "a repo admin sets a review tolerance looser than the org mandates", or "a trigger
loosens a PR out of `review`". The decision is that **loosening must be structurally impossible**,
not merely validated against.

## Decision

1. **Total order, strictest-first:** `review ⊏ plan ⊏ allowAll` for permission mode;
   `critical ⊐ error ⊐ warning ⊐ info` for the blocking severity. Each is a lattice with a
   well-defined *meet* (most-strict).
2. **Compose by meet, never by override:** the effective value is
   `min-privilege(derivedDefault, configuredFloor, …)` — a monotone `tighten()` that takes the
   most-strict of all applicable scopes per field. An org floor a repo can only tighten; a
   per-trigger/sub-event floor is `min(configuredMode, floorFor(subEvent))`.
3. **The PR floor is trust-conditioned; `review` is the default and the untrusted bottom.**
   `floorFor(subEvent, ctx)` returns `review` as a **structural pin** for **untrusted** PR content —
   a fork PR, or an author **below the resolved trusted-author threshold** — so no configuration can
   move it (ADR-004's confused-deputy fence). For a **trusted-internal** PR (non-fork, author
   at/above the threshold) the floor drops so an automation may be configured *above* `review` (write
   PR comments / create linking issues), while `review` remains the **default** when unconfigured. The
   trust context (`isFork`, `author_association`) is derived **server-side from the webhook, never
   user-supplied** — so the floor is a function of trust, and config still only tightens toward it.
   Monotonicity is unchanged: `rank(effective) ≤ rank(floorFor(subEvent, ctx))`. (Relaxed from a flat
   PR→`review` pin by owner ruling 2026-08-21.)
4. **The trusted-author threshold is itself a posture on this same lattice** (owner ruling
   2026-08-21). Order `author_association` by trust rank
   (`OWNER > MEMBER > COLLABORATOR > CONTRIBUTOR > FIRST_TIME_CONTRIBUTOR > NONE`); the trusted set is
   "rank ≥ T". An admin configures `T` end-to-end; the **org sets the floor `T_org` (the most
   permissive value allowed) and a repo may only *raise* it** (`T_eff = max(T_org, T_repo)` — admit
   fewer authors, never more), composed by the SAME `tighten()` combinator as the other axes. Default
   `T = MEMBER` (whitelist {`OWNER`, `MEMBER`}); `COLLABORATOR` is admissible by configuration. Fork
   PRs remain untrusted regardless of `T` (a hard structural gate; revisit only via a separate ADR).
   This is the composability property generalizing: a new trust knob is just another monotone field,
   not a new code path.
5. **Enforced at the seam, not only in the UI:** the control-plane seam clamps regardless of what
   the caller sends — the UI/zod additionally makes the loosening option un-selectable, but the seam
   is the source of truth (mirrors how ADR-036's approve floor is server-enforced even when the
   caller forgets).

## Anti-deviation invariants

- **Config only tightens toward the floor; the floor for untrusted PR content is `review` and
  structural.** The 2026-08-21 relaxation makes the PR floor *trust-conditioned* (write is
  configurable for trusted-internal PRs), NOT loosenable for untrusted content — a fork/external PR
  can never be configured out of `review`. Write above `review` is **opt-in, never default**.
- **The trust signal (fork, `author_association`) is server-derived from the webhook and MUST NOT be
  user-settable** — a forgeable trust context defeats the fence.
- **A "free trigger→mode map with no floor"** (loosening for untrusted content) was analyzed and
  **rejected as net-negative** (#82): it breaks the guarantee for a convenience nobody needs.
- **Monotonicity is property-tested:** `rank(effective) ≤ rank(derivedDefault)` for every
  (scope, config) tuple (#72, #82 criterion 3).
- Absent configuration reproduces today's derived behavior exactly (regression).

## Options considered

- **Meet/floor lattice (chosen)** vs last-writer-wins override. Chosen: override cannot express
  "a lower scope may only strengthen", which is the whole security property.
- **Enforce in UI only** vs **enforce at the seam (chosen)**. Chosen: a forgotten UI guard or a
  direct API call must not be able to loosen; the seam is the invariant.

## Consequences

- **Positive:** adding a scope (org, team, environment, role) is safe by construction — it can only
  tighten. The same `tighten()` combinator serves both axes and every future one.
- **Negative / watch:** two issues in the family build floors at the same seam — **#82** (per-trigger)
  and **#83** (per-sub-event, its successor). They must not build the floor twice; #82 establishes
  the mechanism and #83 generalizes `floorFor` from trigger to sub-event (sequencing noted in #82).
- **Negative / watch:** configuring a trusted-internal PR *above* `review` requires GitHub write
  without a resident token — it depends on the **broker (#81)**. Until #81 lands, the trusted-internal
  relaxation is defined but not enable-able (the floor still computes; the write capability is gated).

## Standards mapping

The tighten-only floor is a **least-privilege** control (**NIST SP 800-53 AC-6**, **ISO/IEC
27001:2022 Annex A 8.2**): a lower scope may only reduce authority. The trust-conditioned PR bottom
implements the **confused-deputy** (MITRE **CWE-441**) and **prompt-injection** (**OWASP LLM01**)
mitigations — see ADR-004's Standards mapping for the full citation set.

## Testing

- Property tests: monotonicity over all inputs; for untrusted PR content (fork, or rank below
  `T_eff`) `effective === "review"` regardless of config; a trusted-internal PR configured `plan`/
  `allowAll` reaches the daemon at that mode; `T_eff = max(T_org, T_repo)` (a repo cannot admit an
  author the org excluded); a non-PR trigger configured `plan` reaches the daemon as `plan`,
  configured `review` runs emit-only.
