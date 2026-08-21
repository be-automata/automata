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
2. **`review` is the DEFAULT for PR triggers, and a structural pin for untrusted PR content.** An
   unconfigured PR-family automation runs `review` (emit-only). For any PR-family event whose content
   is **untrusted** — a fork PR, or an author whose `author_association` ∉ {`OWNER`, `MEMBER`} — the
   mode is **pinned** to `review` and no configuration can move it (the confused-deputy fence). For a
   **trusted-internal** PR (non-fork, member/owner author) an automation MAY be configured *above*
   `review` (to write PR comments / create linking issues), but `review` stays the default. The trust
   signal is derived **server-side from the webhook payload, never user-set** — otherwise the fence
   is forgeable. See ADR-005 for the trust-conditioned floor. (Relaxed from a flat PR→`review` pin by
   owner ruling 2026-08-21.)
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
- A configured PR-write run (trusted-internal, above `review`) obtains GitHub write via the
  **broker** (#81 — per-run bearer, no resident token), **never a resident credential**. Until #81
  lands, PR-write cannot be enabled, because the only alternative is a resident token — reintroducing
  exactly the exfiltration surface `review` removes.

## Standards mapping

This decision is not house opinion; it implements recognized security guidance, cited here so the
invariant is defensible and auditable:

- **Confused deputy** — MITRE **CWE-441** (Unintended Proxy or Intermediary). A privileged agent
  acting on untrusted PR content is the textbook confused deputy; capability removal is the remedy.
- **Prompt injection** — **OWASP Top 10 for LLM Applications, LLM01: Prompt Injection**. Untrusted PR
  text is attacker-controlled input to the model.
- **Excessive Agency** — **OWASP for LLM Apps** (LLM08:2023 / LLM06:2025). The named mitigation is to
  minimize the tools/permissions/autonomy an agent holds — precisely emit-only + token strip.
- **Least privilege** — **NIST SP 800-53 AC-6**, **ISO/IEC 27001:2022 Annex A 8.2** (privileged
  access rights). The agent gets the least authority that lets it do its job (read + emit).
- **Information-flow / single-writer** — **NIST SP 800-53 AC-4** (information flow enforcement); the
  control plane is the single writer, so the untrusted agent cannot drive an external side effect.
- Capability-based framing: **Principle of Least Authority (POLA)** — absence of a credential is a
  stronger guarantee than a scoped one.
- GitHub-specific: the `pull_request` / bot-authored-event confused-deputy pitfall is why
  fork + `author_association` gating is the standard trust boundary (mirrors GitHub Actions security
  hardening guidance on running privileged logic against untrusted PRs — and why Evergreen excludes
  `pull_request` triggers entirely).

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
- Trust-conditioned floor property test: for every fork PR and every PR whose `author_association` ∉
  {`OWNER`, `MEMBER`}, `effective === "review"` regardless of config; a non-fork member/owner PR
  configured above `review` reaches the daemon at the configured mode, and its GitHub write arrives
  via the broker (#81), asserted with no resident token in env/argv/disk.
