# ADR-005: Permission and posture controls are monotone floors — tighten-only

- **Status:** Accepted (2026-08-21) as the governing invariant for epic #70 Track P (#71–#74) and its
  successors #82 (per-trigger `permissionMode` floor) and #83 (per-sub-event granularity). The
  review-severity axis (`blockTolerance`) already ships; this ADR fixes the *shape* every current
  and future strictness control must take.
- **Date:** 2026-08-21
- **Context source:** `packages/shared/src/db/schema.ts:1411` (`blockTolerance` on
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
3. **PR-family is pinned to `review` structurally:** `floorFor` returns `review` for every PR-family
   sub-event that executes untrusted PR content, so no configuration value can move it out of
   `review` (this is ADR-004's fence, expressed as the floor's bottom element).
4. **Enforced at the seam, not only in the UI:** the control-plane seam clamps regardless of what
   the caller sends — the UI/zod additionally makes the loosening option un-selectable, but the seam
   is the source of truth (mirrors how ADR-036's approve floor is server-enforced even when the
   caller forgets).

## Anti-deviation invariants

- **No loosening path may ever be added** — not a per-repo override, a per-trigger map, nor a
  free-form config. A "free trigger→mode map with no floor" was analyzed and **rejected as
  net-negative** (#82): it breaks the guarantee for a convenience nobody needs.
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

## Testing

- Property tests: monotonicity over all inputs; `effective(pull_request, *) === "review"`; a non-PR
  trigger configured `plan` reaches the daemon as `plan`, configured `review` runs emit-only.
