# Architecture Decision Records

Durable records of load-bearing decisions. An ADR outlives any working session and is the first
place a coding agent or reviewer should look before changing a security- or composability-critical
seam — the **Anti-deviation invariants** section of each ADR states what must not regress.

| ADR | Decision | Status |
|-----|----------|--------|
| [ADR-001](ADR-001-tenant-scoping-enforcement.md) | Tenant scoping enforcement — the daemon token is org-scoped | Accepted |
| [ADR-002](ADR-002-per-org-execution-plane.md) | Per-org execution plane + credential-placement rules | Accepted |
| [ADR-003](ADR-003-execution-plane-www-dispatch-seam.md) | The www→Hatchet dispatch seam | Accepted |
| [ADR-004](ADR-004-review-lane-emit-only-credential-fence.md) | The review lane is emit-only with a structural credential fence | Accepted |
| [ADR-005](ADR-005-monotone-permission-and-posture-floors.md) | Permission/posture controls are monotone floors — tighten-only | Accepted |
| [ADR-006](ADR-006-shape-not-kind-agent-agnostic-harness.md) | Planes receive resolved shapes, not credential kinds; agent-agnostic harness | Accepted |
| [ADR-007](ADR-007-supersession-authority-and-box-budget.md) | Supersession authority (engine-only) + the one-agent box budget | Proposed |

**Note:** [`../uat/adr-036-effect-intent.md`](../uat/adr-036-effect-intent.md) documents the
effect-intent / emit-only wire format under `docs/uat/` (separate numbering); ADR-004 references it
as the mechanism behind the review write path.

## Forward-looking (RFCs, tracked as GitHub issues — not yet Accepted ADRs)

These are proposed directions still under design; they become ADRs when accepted and implemented.

- **#84** — Roles as first-class actor (identity + permission floor + credential-gated model).
- **#85** — Host batteries + in-sandbox orchestration (thin skills over a guaranteed capability host).
- **#83** — Sub-event trigger granularity + mirror-intake fold (extends ADR-005 to per-sub-event).
- **#153** — v1 thread-chat model (multi-harness agents on one PR; premium capability, undecided).

## Writing a new ADR

Match the house format (see ADR-003/004): a title; a metadata block (**Status**, **Date**,
**Context source** with `file:line` anchors, **Deciders**, **Relates to**, **Supersedes**); then
**Context**, **Decision**, **Options considered**, **Consequences** (positive / negative-watch), and
**Testing**. For a security- or composability-critical decision, add an **Anti-deviation invariants**
section stating what must always hold. Keep the facts inline and anchored — an ADR must be
self-contained once the authoring session is gone.
