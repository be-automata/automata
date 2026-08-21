# ADR-004: The review lane is emit-only with a structural credential fence

- **Status:** Accepted, **AMENDED 2026-08-21, AMENDED AGAIN 2026-08-21 (#88)** — an adversarial
  review found the env-strip is not total (on-disk `~/.git-credentials` channel + non-Claude gap +
  OpenCode auto-approve). Of the three verified gaps: gap 2 (non-Claude env-strip) was CLOSED by
  #76; gap 3 (OpenCode auto-approve) is CLOSED by #88 (mode-aware plugin) plus a per-harness
  tool-policy applied where a restriction could be verified safe against the pinned CLI version
  (claude only — codex/gemini/amp/opencode ship `[]` + a documented reason, see "Amendment 2026-08-21
  (#88)" below); gap 1 (on-disk credential file) remains OPEN, tracked by #89. **The invariant does
  NOT fully hold yet** — see both amendments. The Claude env-strip is in production and
  regression-pinned (#80).
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
level, _opt-out-by-omission_ for non-Claude harnesses (only `runClaudeCodeCommand` passed
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
   _above_ `review` (to write PR comments / create linking issues), but `review` stays the default.
   The **trusted-author whitelist is itself a configurable, monotone posture** (§ADR-005): an admin
   defines which `author_association` levels count as trusted for write; the org sets a floor a repo
   can only _tighten_ (admit fewer, never more); the default is {`OWNER`, `MEMBER`}, and `COLLABORATOR`
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

- **Required invariant (env-strip half: CLOSED by #76):** _every_ harness's review run must produce
  a spawn env with no GitHub credential — not just Claude. This is enforced via the **typed
  capability** (`withholdGitCredentialsInReviewMode`, ADR-006), asserted per-agent (#76 acceptance
  criterion 5, regression-pinned in `daemon-golden.test.ts`'s five-agent review loop). A new CLI
  cannot silently ship without the fence.
- **Required invariant (tool-policy half: PARTIALLY closed by #88).** Every adapter exposes a named
  `reviewPolicyArgs()` seam (ADR-006 contract). As of #88, claude ships a verified restriction
  (unchanged from pre-#88); codex, gemini, amp, and opencode ship `[]` — each with a documented,
  version-pinned reason in its adapter (codex.ts / gemini.ts / amp.ts / opencode.ts) for why no
  args-level restriction could be verified safe (would hang, error out the run, or isn't the right
  seam for that CLI). opencode's real fence for #88 is NOT `reviewPolicyArgs()` — it is the
  mode-aware auto-approve plugin (see "Amendment 2026-08-21 (#88)" below), which denies every
  `permission.ask` in review mode. The env-strip (`withholdGitCredentialsInReviewMode`) remains the
  hard guarantee for the four `[]` harnesses; tool-policy there is future work once a CLI restriction
  can be verified against its pinned version.
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
   (`packages/sandbox/src/setup.ts:166-202`) runs **unconditionally** in `setupSandboxEveryTime`
   (call at `setup.ts:213`, not review-gated) and writes the token **plaintext** to
   `~/.git-credentials` while setting `credential.helper store` globally. `stripGithubCredentials`
   removes only env keys, so a prompt-injected review agent can `cat ~/.git-credentials` (exfiltrate)
   or just `git push` (the helper supplies the token). The Claude review tool-policy denies
   `Bash(git push:*)`/`gh` but **not `cat`**.
2. **Non-Claude harnesses get no tool-policy AND no env-strip (HIGH, verified). CLOSED by #76.**
   `withholdGitCredentials` was passed only by `runClaudeCodeCommand`; Codex/Amp/Gemini/OpenCode
   called `spawnAgentProcess` without it. #76's generic `runAgentCommand` now reads
   `adapter.capabilities.withholdGitCredentialsInReviewMode` uniformly for every agent
   (`daemon.ts`'s `runAgentCommand`), regression-pinned by the inverted five-agent review-mode test
   in `daemon-golden.test.ts`. The tool-policy half of this gap (as opposed to env-strip) is
   separately addressed by #88 — see the 2026-08-21 (#88) amendment below.
3. **OpenCode auto-approves every permission (HIGH, verified). CLOSED by #88.**
   `OPENCODE_AUTO_APPROVE_PLUGIN_CONTENT` (`packages/sandbox/src/agents/opencode-config.ts`,
   installed at `setup.ts:419`) previously returned `output.status = "allow"` unconditionally. #88
   makes it mode-aware: it reads a `TERRAGON_REVIEW_MODE` env marker (set by
   `opencodeAdapter.prepareEnv` when `permissionMode === "review"`) and denies every
   `permission.ask` in review mode, while normal-mode behavior is byte-for-byte unchanged. See the
   2026-08-21 (#88) amendment below for detail and its residual scope.

**Required fix to make the invariant true (this ADR's real DoD):** for a review run, in addition to
the env-strip — (a) remove `~/.git-credentials` and `git config --global --unset credential.helper`
(or never write them in the review provisioning path); (b) apply the review tool-policy for EVERY
harness, and disable the OpenCode auto-approve plugin in review mode; (c) note that `permissionMode`
is CLI-argument scoping, **not an OS capability boundary** — an agent with `Bash` can launch another
CLI with different flags, so the credential must be _absent from the box_, not merely denied by
policy. The durable end-state is the broker (#81): the token is never resident on the review box at
all. Tracking: this amendment's fixes should be a child of #81 / folded into #76.

## Amendment 2026-08-21 (#88) — tool-policy for ALL harnesses + OpenCode plugin fixed; on-disk gap still open

#88 closes gap 3 above (OpenCode auto-approve) and adds a per-harness `reviewPolicyArgs()` review
tool-policy to the `HarnessAdapter` contract for every one of the five adapters (ADR-006). It does
**NOT** close gap 1 (on-disk `~/.git-credentials`) — that is still #89's scope — so this ADR's
invariant is **still not fully enforced** after #88 lands.

**Per-CLI tool-policy outcome (orchestrator safety ruling: a fence that hangs or breaks the run is
worse than the status quo — the env-strip is the hard guarantee, `reviewPolicyArgs()` is
best-effort defense-in-depth applied only where verified safe against the PINNED sandbox CLI
version):**

| Harness  | Pinned version         | Outcome                                       | Reason                                                                                                                                                                                                                                                                                                                                                                            |
| -------- | ---------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| claude   | 2.0.65 / 2.1.235       | **Shipped** (pre-existing, unchanged)         | `--permission-mode default` + `--disallowedTools` for `gh`/`git push`, `--setting-sources user`.                                                                                                                                                                                                                                                                                  |
| codex    | 0.76.0                 | `[]`                                          | Candidate `--sandbox read-only` rejected: Codex's Landlock/seccomp sandbox is documented as unreliable inside containers without `SYS_ADMIN` (commonly errors or falls back to full access), and read-only mode does not block network access even where it does function.                                                                                                        |
| gemini   | 0.20.0                 | `[]`                                          | Candidate (drop `--yolo` + allowlist) rejected: without `--yolo`, gemini-cli's non-interactive scheduler errors (`ToolErrorType.CONFIRMATION_REQUIRED`) on any tool call needing confirmation — breaking the run, not hanging, but still worse than status quo; the allowlist flag (`--allowed-tools`) is documented deprecated and its exact behavior at 0.20.0 is unverifiable. |
| amp      | 0.0.1765471542-g74e231 | `[]`                                          | No verified CLI-argument restriction surface exists; amp's documented permission controls (`amp.dangerouslyAllowAll`, `amp.permissions`) are `settings.json` keys, not `amp exec` flags.                                                                                                                                                                                          |
| opencode | 1.0.149                | `[]` (args) + **plugin fix (the real fence)** | Args are the wrong seam for opencode — its permission surface is the `permission.ask` plugin hook. The plugin (`OPENCODE_AUTO_APPROVE_PLUGIN_CONTENT`) is now mode-aware: it denies every ask when `TERRAGON_REVIEW_MODE=1`, set via `opencodeAdapter.prepareEnv` in review mode.                                                                                                 |

**Why an env var, not a rewritten `OPENCODE_CONFIG_CONTENT`:** the alternative seam considered —
swapping the opencode provider config (`buildOpencodeConfig`) itself in review mode — risks silently
replacing the `terry*` provider block the model actually needs to reach the proxy, which would be a
silent outage, not a security improvement. The env-marker + plugin approach changes nothing about
provider config; it only changes what `permission.ask` returns. A provider-config-based hardening is
left as documented future work, not attempted here.

**`permissionMode` on `PrepareEnvContext`:** #88 adds `permissionMode` to the context `prepareEnv`
receives (`adapters/types.ts`). This is allowed under ADR-006's SHAPE-not-KIND boundary: the value
was already resolved and already reached `buildArgs` via `BuildArgsConfig.permissionMode` — this
only makes the same already-resolved SHAPE-level value visible to `prepareEnv` too. No credential
kind, `userId`, or `organizationId` was added.

**What remains open after #88:** gap 1 (the on-disk `~/.git-credentials` file, written unconditionally
by `setupGitCredentials`) is untouched by this PR and remains the primary way ADR-004's invariant is
not yet fully true. #89 tracks closing it. Do not read #88 as making the review fence complete — it
closes the tool-policy and OpenCode-plugin gaps only.

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
  adapters. A golden test pins `reviewPolicyArgs()` output (#75); #88 extends the golden pin to all
  five adapters' `reviewPolicyArgs()` (`adapter-golden.test.ts`), the review-mode command string
  carrying the policy where non-empty (`daemon-golden.test.ts`'s five-agent review loop), and the
  opencode `TERRAGON_REVIEW_MODE` env marker (present in review, absent in allowAll). The mode-aware
  plugin itself is unit-tested in `packages/sandbox/src/agents/opencode-config.test.ts` (extracts and
  evals the plugin's `output.status` assignment against both marker states), plus a
  `setup.test.ts` case asserting the written plugin file content.
- **On-disk fence assertion (amendment):** in a review run, `~/.git-credentials` is absent (or
  empty) and `git config --global credential.helper` is unset — assert on the box, and prove a
  `cat ~/.git-credentials` / `git push` yields nothing usable. Run this per-harness, and prove the
  OpenCode auto-approve plugin is disabled in review mode.
- Trust-conditioned floor property test: for every fork PR and every PR whose `author_association` ∉
  {`OWNER`, `MEMBER`}, `effective === "review"` regardless of config; a non-fork member/owner PR
  configured above `review` reaches the daemon at the configured mode, and its GitHub write arrives
  via the broker (#81), asserted with no resident token in env/argv/disk.
