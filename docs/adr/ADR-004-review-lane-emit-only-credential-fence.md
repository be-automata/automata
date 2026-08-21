# ADR-004: The review lane is emit-only with a structural credential fence

- **Status:** Accepted, **AMENDED 2026-08-21** — an adversarial review found the env-strip is not
  total (on-disk `~/.git-credentials` channel + non-Claude gap + OpenCode auto-approve); the
  invariant is the target, but is NOT yet fully enforced. See "Amendment 2026-08-21" for the verified
  gaps and the real DoD. The Claude env-strip is in production and regression-pinned (#80).
- **Date:** 2026-08-21
- **Context source:** #65 (broker git credentials — review lane verified), #80 (review-lane fence
  regression test), `packages/daemon/src/daemon.ts` (`stripGithubCredentials`,
  `runClaudeCodeCommand` `withholdGitCredentials`), `packages/worker/src/agent-run/daemon-env.ts:193-196`
  (the git extraheader vars removal targets), `apps/www/src/server-lib/remote-daemon-message.ts:138-149`
  (permissionMode derivation), `apps/www/src/server-lib/review/review-single-writer-finish.ts` (`isReviewThread`),
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
   which removes `GH_TOKEN`, `GITHUB_TOKEN`, and `GIT_CONFIG_COUNT|KEY_n|VALUE_n` from the agent
   **environment**. A review run is intended to perform **no authenticated git op and no `gh` call**
   — it reads a pre-provisioned diff offline. **⚠ This env-strip is necessary but NOT sufficient — see
   the 2026-08-21 amendment below: an on-disk credential channel survives it, so the invariant is not
   yet fully enforced.**
2. **`review` is the DEFAULT for PR triggers, and a structural pin for untrusted PR content.** An
   unconfigured PR-family automation runs `review` (emit-only). For any PR-family event whose content
   is **untrusted** — a fork PR, or an author **below the resolved trusted-author whitelist** — the
   mode is **pinned** to `review` and no configuration can move it (the confused-deputy fence). For a
   **trusted-internal** PR (non-fork, author at/above the whitelist) an automation MAY be configured
   *above* `review` (to write PR comments / create linking issues), but `review` stays the default.
   The **trusted-author whitelist is itself a configurable, monotone posture** (§ADR-005): an admin
   defines which `author_association` levels count as trusted for write; the org sets a floor a repo
   can only *tighten* (admit fewer, never more); the default is {`OWNER`, `MEMBER`}, and `COLLABORATOR`
   is admissible by configuration. The trust signal (`isFork`, `author_association`) is derived
   **server-side from the webhook payload, never user-set** — otherwise the fence is forgeable. See
   ADR-005 for the floor. (Relaxed from a flat PR→`review` pin by owner ruling 2026-08-21;
   whitelist made configurable 2026-08-21.)
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

## Amendment 2026-08-21 — the fence is INCOMPLETE (adversarial review, verified)

An adversarial review (codex, independent model, read-only repo access) found that the original
"removal is total" claim is **false**. The env-strip closes the environment channel only; three
on-box channels survive it and must be closed before this ADR's invariant actually holds:

1. **On-disk credential file (HIGH, verified).** `setupGitCredentials`
   (`packages/sandbox/src/setup.ts:184-203`) runs **unconditionally** in `setupSandboxEveryTime`
   (call at `setup.ts:213`, not review-gated) and writes the token **plaintext** to
   `~/.git-credentials` while setting `credential.helper store` globally. `stripGithubCredentials`
   removes only env keys, so a prompt-injected review agent can `cat ~/.git-credentials` (exfiltrate)
   or just `git push` (the helper supplies the token). The Claude review tool-policy denies
   `Bash(git push:*)`/`gh` but **not `cat`**.
2. **Non-Claude harnesses get no tool-policy AND no env-strip (HIGH, verified).** `withholdGitCredentials`
   is passed only by `runClaudeCodeCommand` (`packages/daemon/src/daemon.ts:646-656`); Codex/Amp/
   Gemini/OpenCode call `spawnAgentProcess` without it (`daemon.ts:720-886`). This is the same gap
   #76 criterion 5 tracks — but until it lands, four of five harnesses run review with the token
   fully resident.
3. **OpenCode auto-approves every permission (HIGH, verified).** `OPENCODE_AUTO_APPROVE_PLUGIN_CONTENT`
   (`packages/sandbox/src/agents/opencode-config.ts:154-163`, installed at `setup.ts:419`) returns
   `output.status = "allow"` for all `permission.ask` — so an OpenCode review run has no effective
   tool fence at all.

**Required fix to make the invariant true (this ADR's real DoD):** for a review run, in addition to
the env-strip — (a) remove `~/.git-credentials` and `git config --global --unset credential.helper`
(or never write them in the review provisioning path); (b) apply the review tool-policy for EVERY
harness, and disable the OpenCode auto-approve plugin in review mode; (c) note that `permissionMode`
is CLI-argument scoping, **not an OS capability boundary** — an agent with `Bash` can launch another
CLI with different flags, so the credential must be *absent from the box*, not merely denied by
policy. The durable end-state is the broker (#81): the token is never resident on the review box at
all. Tracking: this amendment's fixes should be a child of #81 / folded into #76.

## Options considered

- **Strip credentials from the review env (chosen)** vs a scoped read-only token. Chosen: absence is
  a stronger guarantee than a narrow token — nothing to leak, nothing to widen.
- **Agent posts its own review** vs **emit-only single-writer (chosen)**. Chosen: a single
  control-plane writer makes "post exactly once, at or above the floor" a property of code the agent
  cannot influence, closing the confused-deputy path on bot-authored PR events.

## Consequences

- **Positive (once the amendment's fixes land):** a review agent cannot push, comment, or leak a
  token even under full prompt injection; the guarantee is layered (tool-policy + env strip + on-disk
  removal + broker) and does not depend on the agent behaving.
- **Negative / watch:** **as of 2026-08-21 the invariant is NOT fully enforced** — the on-disk
  `~/.git-credentials` channel, the non-Claude env-strip gap (#76), and the OpenCode auto-approve
  plugin each defeat it (see Amendment). The env-strip + Claude tool-policy raise the bar but do not
  close the hole. The fence must also be re-proven for every new harness (ADR-006 makes this a typed
  field + a per-agent test). Non-review lanes hold a resident token by design and need the broker
  (#81) — the review lane needs the SAME broker to be truly credential-free.

## Testing

- `daemon.test.ts` "#65 wiring" dispatches a real review-mode message and asserts the captured spawn
  env is credential-free; normal mode keeps it. #76 extends this from Claude-only to all five
  adapters. A golden test pins `reviewPolicyArgs()` output (#75).
- **On-disk fence assertion (amendment):** in a review run, `~/.git-credentials` is absent (or
  empty) and `git config --global credential.helper` is unset — assert on the box, and prove a
  `cat ~/.git-credentials` / `git push` yields nothing usable. Run this per-harness, and prove the
  OpenCode auto-approve plugin is disabled in review mode.
- Trust-conditioned floor property test: for every fork PR and every PR whose `author_association` ∉
  {`OWNER`, `MEMBER`}, `effective === "review"` regardless of config; a non-fork member/owner PR
  configured above `review` reaches the daemon at the configured mode, and its GitHub write arrives
  via the broker (#81), asserted with no resident token in env/argv/disk.
