# ADR-004: The review lane is emit-only with a structural credential fence

- **Status:** Accepted (2026-08-21). The mechanism is already in production and regression-pinned
  (#80); this ADR restates it as a durable invariant so the protected review harness cannot be
  loosened by a later change or a new coding-agent CLI.
- **Date:** 2026-08-21
- **Context source:** #65 (broker git credentials — review lane verified), #80 (review-lane fence
  regression test), `packages/daemon/src/daemon.ts` (`stripGithubCredentials`,
  `runClaudeCodeCommand` `withholdGitCredentials`), `packages/daemon/src/daemon-env.ts:193-196`
  (the git extraheader vars removal targets), `apps/www/src/server-lib/remote-daemon-message.ts:138-149`
  (permissionMode derivation), `packages/*/review-single-writer-finish.ts` (`isReviewThread`),
  `parse-review-intent.ts` + `resolve-approve-floor.ts` (control-plane verdict handling),
  `docs/uat/adr-036-effect-intent.md` (the effect-intent / emit-only mechanism).
- **Deciders:** operator + 2026-08-21 architecture pass
- **Relates to:** ADR-036 (effect-intent — the emit-only wire format), ADR-005 (review is the
  strictest value of the permission floor), ADR-006 (`withholdGitCredentialsInReviewMode` becomes a
  typed adapter capability). Tracks #70/#82/#83/#75/#76.
- **Supersedes / superseded by:** —

## Context

A review agent runs against **untrusted PR content**. If it held a reusable GitHub credential, a
prompt-injected PR could exfiltrate it or push with it. Automata's answer is not a setting the
operator can toggle — it is a **capability-class removal** enforced at two independent layers. This
ADR fixes that as an invariant because it is the single most important "do not deviate" property of
the platform, and because the 2026-08-21 architecture review found the guarantee was, at the code
level, *opt-out-by-omission* for non-Claude harnesses (only `runClaudeCodeCommand` passed
`withholdGitCredentials`). That gap is being closed structurally (ADR-006 / #76); the invariant
below is what any implementation must preserve.

## Decision

1. **No resident credential.** When `permissionMode === "review"`, the daemon sets
   `withholdGitCredentials`, and `spawnAgentProcess` applies `stripGithubCredentials(childEnv)`,
   which removes `GH_TOKEN`, `GITHUB_TOKEN`, and `GIT_CONFIG_COUNT|KEY_n|VALUE_n` (the git
   extraheader auth is applied via exactly those `GIT_CONFIG_*` vars, so removal is total). A review
   run performs **no authenticated git op and no `gh` call** — it reads a pre-provisioned diff
   offline.
2. **`review` is derived, not user-set, for PR triggers.** `isReview` is TRUE exactly when the
   automation is PR-triggered (`isReviewThread`), and after #83 it is sub-event-aware. A PR-family
   run can never leave `review` (see ADR-005 for the floor that makes this structural).
3. **Emit-only single-writer (the write path).** The review agent has **no `gh` / `git push`
   tools**. It emits a fenced-JSON verdict; the **control plane** parses it
   (`parse-review-intent.ts`), validates the severity against the approve floor
   (`resolve-approve-floor.ts`), and posts the review **exactly once**. A parse failure yields a
   degraded marker — never an unreviewed merge and never a second writer.

## Anti-deviation invariants (what the protected harness must always hold)

- **Every** harness's review run produces a spawn env with no GitHub credential — not just Claude.
  This is a **typed capability** (`withholdGitCredentialsInReviewMode`, ADR-006) and is asserted
  per-agent (#76 acceptance criterion 5), so a new CLI cannot silently ship without the fence.
- The approve floor is **server-enforced** regardless of what the agent emits or omits — the agent
  cannot approve below the floor by malformed output.
- Adding a git-write or `gh` tool to the review tool-policy is forbidden. The review policy lives in
  a **named seam** (`reviewPolicyArgs()`, #75) that a golden test pins.

## Options considered

- **Strip credentials from the review env (chosen)** vs a scoped read-only token. Chosen: absence is
  a stronger guarantee than a narrow token — nothing to leak, nothing to widen.
- **Agent posts its own review** vs **emit-only single-writer (chosen)**. Chosen: a single
  control-plane writer makes "post exactly once, at or above the floor" a property of code the agent
  cannot influence, closing the confused-deputy path on bot-authored PR events.

## Consequences

- **Positive:** a review agent cannot push, comment, or leak a token even under full prompt
  injection; the guarantee is two-layered (tool-policy + env strip) and does not depend on the agent
  behaving.
- **Negative / watch:** the fence must be re-proven for every new harness (ADR-006 makes this a typed
  field + a per-agent test, not a manual reminder). The non-review lanes still hold a resident token
  and need the broker work (#81) — that is a *separate* lane, out of this ADR's scope.

## Testing

- `daemon.test.ts` "#65 wiring" dispatches a real review-mode message and asserts the captured spawn
  env is credential-free; normal mode keeps it. #76 extends this from Claude-only to all five
  adapters. A golden test pins `reviewPolicyArgs()` output (#75).
