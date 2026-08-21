# ADR-006: Planes receive resolved shapes, not credential kinds — and the harness is agent-agnostic

- **Status:** Accepted (2026-08-21). The SHAPE-not-KIND boundary is already true today; the
  agent-agnostic adapter is the committed direction of epic #70 Track A (#75–#78). This ADR fixes the
  composability invariant so per-agent knowledge cannot leak back into the orchestrator or the
  execution planes.
- **Date:** 2026-08-21
- **Context source:** `apps/www/src/agent/credentials.ts` (control-plane KIND→SHAPE resolution),
  `apps/www/src/server-lib/credentials.ts:64` (connected credentials grouped by agent),
  `packages/worker/src/agent-run/agent-credentials.ts:21` (`CREDENTIAL_FILE_BY_AGENT`),
  `packages/daemon/src/daemon.ts:358-384` (dispatch switch + five `run*Command` methods — the smell),
  `packages/sandbox-image/Dockerfile.hbs` + `packages/sandbox-image/src/index.ts:17`
  (`getTemplateIdForSize({provider, size})` — one universal image, no agent axis),
  `packages/agent/src/utils.ts` (`modelToAgent`, `agentToModels`, `getAgentModelGroups`),
  `apps/www/src/lib/subscription-tiers.ts` (tier gate).
- **Deciders:** operator + 2026-08-21 architecture pass
- **Relates to:** ADR-004 (`withholdGitCredentialsInReviewMode` + `reviewPolicyArgs()` become typed
  adapter capabilities), ADR-005 (planes receive the resolved mode only). Tracks #70/#75/#76/#77/#78;
  enables #84 (roles) and #85 (batteries).
- **Supersedes / superseded by:** —

## Context

A coding-agent CLI (claude/codex/gemini/amp/opencode) differs in args, env, auth-file path, output
parser, and model set. Today that per-agent knowledge is scattered across three layers, and the
worst of it — a dispatch switch plus five ~70%-duplicated `run*Command` methods — lives **inside the
daemon orchestrator**, where the credential fence (ADR-004) became opt-out-by-omission. The decision
is a strict separation: the control plane resolves *identity and credential kind* into a *shape*, and
everything below the control plane consumes only shapes and an agent identity — never the kind, the
user, or the org.

## Decision

1. **SHAPE-not-KIND boundary.** The control plane resolves credential **KIND** (subscription /
   API key / OAuth file) into a **SHAPE** (`json-file` | `env-var` | `built-in-credits`). The worker,
   sandbox, and daemon receive the resolved shape + the agent identity **only** — never the KIND, a
   `userId`, or an `organizationId`. A compile-level guard proves no kind/identity can be passed to
   `prepareEnv`/`authFilePath` (#75 criterion 2).
2. **One adapter per harness.** A `HarnessAdapter` interface (`agent`, `displayName`,
   `authFilePath()`, `prepareEnv(ctx)`, `buildArgs(cfg)`, `normalizeModel(model)`,
   `makeLineParser()`, `capabilities`) plus a registry replaces the daemon switch and the five run
   methods (#75/#76). Adding a CLI is **one file**, not a shotgun edit.
3. **Security guarantees are typed capabilities, not orchestrator branches.**
   `capabilities.withholdGitCredentialsInReviewMode` (ADR-004) and the named `reviewPolicyArgs()`
   (#75) are fields every adapter must supply, verified per-agent (#76 criterion 5). The generic
   `runAgentCommand` applies them uniformly.
4. **The sandbox image is agent-agnostic.** One universal image per `(provider, size)` bakes all five
   CLIs; `getTemplateIdForSize` takes no `agent` argument. The harness is chosen at runtime by which
   CLI the daemon invokes. Only per-CLI post-install patches are harness-specific, and they live
   inside that one image.
5. **Model selection resolves from connected credentials.** The models a scope may bind are
   `agentToModels()` over the agents the org actually has credentials for (`credentials.ts` grouping),
   tier-filtered — never a free list. This is the seam #84 (roles) and #85 (skill `requires`) reuse.

## Anti-deviation invariants

- No per-agent `switch` / `run*Command` may exist in `daemon.ts` (grep-gated, #76 criterion 2).
- Nothing below the control plane may branch on credential kind, user, or org — only on the resolved
  shape and agent identity (composability grep-gate, repeated in #82/#83/#84/#85 acceptance criteria).
- A new capability (a battery in #85, a role binding in #84) resolves to a **shape** the planes
  honor — never a new credential kind the planes must understand.

## Options considered

- **One adapter file per CLI + registry (chosen)** vs the status-quo switch. Chosen: the switch made
  the credential fence optional and duplicated the parse→capture→backfill loop five times.
- **Per-agent images** vs **one universal image (chosen)**. Chosen: a single artifact to build,
  scan, and patch; the runtime already selects the CLI. A battery installs once and is available to
  every harness.

## Consequences

- **Positive:** adding a coding agent, a battery, or a role is a localized, typed change; the fence
  and the shape boundary cannot regress silently.
- **Negative / watch:** #76 is the regression-risk cutover — A1's golden tests (#75) are the
  guardrail that the deletion is byte-identical. The image growing with baked batteries (#85) is
  mitigated by keeping heavy/rare tools in the per-env setup script.

## Testing

- Golden characterization tests snapshot each agent's exact args/env/parse and prove the generic path
  reproduces them byte-for-byte (#75/#76). Compile test for the SHAPE-not-KIND guard. Per-agent
  review-env assertion (ADR-004 / #76 criterion 5).
