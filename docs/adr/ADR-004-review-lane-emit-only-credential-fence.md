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
   which removes `GH_TOKEN`, `GITHUB_TOKEN`, and every credential-bearing entry of the
   `GIT_CONFIG_COUNT|KEY_n|VALUE_n` group (`http.*extraheader`, `url.*.insteadOf` /
   `pushInsteadOf`, and any value embedding the token) from the agent **environment**. Since #229
   the strip is selective: non-credential entries (`safe.directory`, `user.*`,
   `credential.helper=""`) are kept and renumbered, because the agent-uid review run needs
   `safe.directory` and `GIT_CONFIG_GLOBAL=/dev/null` leaves nothing else to supply it. (The #229
   squash commit on main, 5f9a6d4, is titled "(#228) (#229)"; the "#228" is wrong — #228 is the
   unrelated ticket-comment PR whose bot review first hit the bug.) A review run is intended to perform **no authenticated git op and no `gh` call**
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
   **Scoped 2026-08-25 (#140):** the degraded marker is a claim about live HEAD, so it is
   posted only by a run that can speak for HEAD. A run dispatched against an older commit,
   or abandoned before it could emit (`ABANDONED_TERMINAL_CAUSES`), reports the parse
   failure through telemetry (`skipped_stale_degrade`, `workFailed`) instead of onto the
   PR. This narrows the marker, never the verdict: a parsed intent from such a run still
   posts, at the commit it reviewed. Exactly-once and no-second-writer are unchanged.
   **Scoped 2026-10-03:** exactly-once is counted per commit and is permanent. A verdict the
   bot delivered at a commit and later dismissed (the reconciler dismisses older verdicts on
   every run) was still delivered; dismissal changes whether it is in force, not whether it
   was posted. The replay guard, the supersession guard and the sweep's HEAD guard all ask
   "did the bot ever review this commit?" (`findAnyBotReviewAtCommit`), so the hourly sweep
   cannot re-post a PR's dismissed verdicts and cannot undo a person's dismissal.

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

## Amendment 2026-10-04 (review-agent batteries, D2) — in-run fan-out allowed for orchestrated mode; the PR surface stays single-writer

**What D2 changes.** An ORCHESTRATED review run (Phase 4 admin setting, resolved control-plane-side
and stamped on the daemon message by the worker) may spawn sub-agents and invoke skills inside the
run. What this ADR protects is the PR surface, not the agent's internal structure, and that surface
is unchanged. The review agent still holds no GitHub credential (`withholdGitCredentials` /
`stripGithubCredentials`). `'Bash(gh:*)'` and `'Bash(git push:*)'` stay denied for the lead AND for
every sub-agent, because sub-agents inherit the parent's deny list (Phase 2 spike, Q4: gh, git push,
Write and WebFetch were refused inside a sub-agent with no `tools:` frontmatter). The platform still
posts exactly one review, from the lead's final fenced JSON.

**Orchestrated delta vs the classic golden.** `REVIEW_POLICY_JOINED` is unchanged, and classic runs
(reviewAgent absent, `mode: "classic"`, malformed, or any non-review run) are byte-identical to
before. The orchestrated variant is pinned as `ORCHESTRATED_REVIEW_POLICY_JOINED`, and its env as
`expectedClaudeEnvOrchestratedReview`, both in `packages/daemon/src/adapters/__golden-fixtures.ts`:

| Element                   | Classic (ADR-004 golden)          | Orchestrated (D2)                                                                                                 |
| ------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `--allowedTools`          | `Read Grep Glob Bash`             | `Read Grep Glob Bash Agent Task Skill` (both sub-agent names: CLI 2.1.284 lists `Task` in init but emits `Agent`) |
| `--disallowedTools`       | `'Bash(gh:*)' 'Bash(git push:*)'` | the same two, plus `Write Edit WebFetch WebSearch` (an explicit deny beats a skill's `allowed-tools`)             |
| `--setting-sources`       | `user`                            | `user` (kept: the PR's project `.claude/` and `.mcp.json` never load, spike Q3)                                   |
| `--max-turns`             | absent                            | `--max-turns N` only when set. It bounds the lead loop only and is not a cost bound (spike Q5)                    |
| env `BASH_MAX_TIMEOUT_MS` | `60000`                           | the payload's `commandTimeoutMs` (60000..600000). Every other run stays `60000`                                   |

**Per-run HOME.** The selected battery packs are symlinked at the USER layer
(`<home>/.claude/skills/<id>`, `<home>/.claude/agents/<id>.md`) from root-owned
`/usr/local/lib/automata-batteries/<id>@<sha>`. Every target is realpath-contained under that root.
The root and each pack must be root-owned and not group- or other-writable. A pack is skipped on any
doubt: a symlink inside it, or any `hooks` / `bin` / `.claude-plugin` / `settings.json` /
`settings.local.json` / `.mcp.json` / `plugin.json` segment. A missing, invalidated, malformed or
drifted install manifest means no packs; the run is still orchestrated and the review never fails
for it. `~/.claude/settings.json` gets `disableAllHooks: true`, so user-level SubagentStart/Stop
hooks cannot fire per sub-agent. Nothing from the PR's project layer loads (`--setting-sources user`).

**Completion.** With a background sub-agent the CLI emits two `result` messages, and the first holds
the lead's interim text. The daemon holds results once the lead's own Agent/Task call is confirmed
backgrounded, and releases only the LAST one at process exit. `extractTerminalAgentText` ignores
sub-agent messages (`parent_tool_use_id` non-null), so a sub-agent fence can never become the review.
Residual risk, owned by Phase 6 (prompt rules + parser fixtures): a lead that quotes a sub-agent's
fence verbatim (spike q4sub).

**Wallet bound.** Unchanged: the Hatchet `executionTimeout` plus the idle watchdog.

**Rollback.** Set the repo/org review mode back to classic in Settings → Review. Classic
argv/env/HOME are byte-identical to before this amendment.

## Amendment 2026-10-04 (phase 7) — read-only task token

**What changes.** A TASK run (manual, scheduled or mention; never a review) may hold a real GitHub
credential in its agent env: a read-only, single-repo, ≤1h GitHub App installation token in
`GITHUB_TOKEN`. It gets one only when an admin-selected pack (Settings → Review → Task agent packs)
declares `requires: ["github-read-token"]` in `packages/worker/deploy/batteries.json`. Today only
`somnio-skills` declares it. Selecting the pack IS the opt-in (D1); there is no extra toggle and no
env var.

**Why.** The vendored `skills/dora-metrics/scripts/dora_metrics.py` (somnio-ai-tools @ aa53f071)
hard-codes `API_ROOT = "https://api.github.com"` and reads `GITHUB_TOKEN`, then `gh auth token`.
Under the credential broker both yield the per-run bearer, which GitHub rejects with 401. A loopback
forwarder would need the vendored code patched (rejected), and a CONNECT proxy cannot rewrite a
header inside TLS.

**Token shape.** `getReadOnlyInstallationToken` (`packages/shared/src/github-app.ts`) POSTs
`/app/installations/{id}/access_tokens` with exactly
`{ repositories: [repo], permissions: { contents: "read", metadata: "read", pull_requests: "read", issues: "read" } }`.
The body has no write or admin key, by construction. GitHub caps installation tokens at one hour.

**Where it flows.**

- www mints the token at dispatch, ONLY for a non-review org dispatch whose resolved task packs
  require it. It ships the token in the Hatchet run input as the secret `githubReadToken`, handled
  exactly like `installationToken` (never logged), plus the non-secret `githubReadTokenExpiresAt`.
- A mint failure dispatches without the token and logs one warn line (message only, redacted).

**Worker gate (`readTokenForRun`, `packages/worker/src/agent-run/workflow.ts`).** The token reaches
the agent only when ALL of these hold:

1. the run is not the review lane;
2. the task-pack gate seeded, seeding succeeded, and a seeded pack's OWN manifest entry requires
   `github-read-token`;
3. the token was delivered;
4. `githubReadTokenExpiresAt` is more than one minute away (in the past or unparseable fails
   closed);
5. the run is brokered.

**gh and git stay brokered.**

- `GH_TOKEN` stays the per-run broker bearer. gh prefers `GH_TOKEN` over `GITHUB_TOKEN`, so gh still
  reaches the gh broker over its unix socket.
- git stays on the git broker (`url.insteadOf` + bearer).
- Every other run's env is byte-identical to before: no requiring pack, review lane, token absent or
  expired, or legacy unbrokered.

**The review lane is untouched.** www never mints for a review dispatch. The worker gate refuses a
forged `githubReadToken` on the review lane, and the daemon's review-mode `stripGithubCredentials`
still removes `GH_TOKEN`/`GITHUB_TOKEN` on top. The invariant of this ADR stands: no write credential
ever reaches an agent, and a review agent holds no GitHub credential at all.

**Residual risks, accepted for a read-only, single-repo, ≤1h token:**

1. The token sits in the Hatchet run input, exactly like `installationToken`. Anyone who can read
   run inputs in the engine can read it while it is valid.
2. The agent runs with skip-permissions and can print its env. Anything it prints lands in the
   transcript, which the control plane stores. A leaked token can read that one repository (code,
   issues, PR metadata) for at most an hour. That is no more than the agent already has from its
   clone, plus issue and PR metadata.

**Pinned by tests.**

| Concern                         | Test                                                                                                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Minter body                     | `packages/shared/src/github-app.test.ts`: exactly four `read` permissions + `[repo]`, no write/admin, no `expires_at`                                                                                     |
| Dispatch gating and log hygiene | `apps/www/src/agent/hatchet/dispatch.test.ts`: minted only for a requiring pack; never on review or no-org; read token ≠ installation token; mint failure degrades; no console argument carries the token |
| Manifest/shared parity          | `deploy-assets.test.ts` (`requires` == `BATTERY_PACK_REQUIRES`, executed bash/TS parity) and `batteries-manifest.test.ts`                                                                                 |
| Env matrix                      | `daemon-env.test.ts`: brokered + token ⇒ only `GITHUB_TOKEN` changes; otherwise byte-identical; legacy ignores it                                                                                         |
| Gate and expiry                 | `workflow-cleanup.test.ts`: `readTokenForRun` units plus run-fn cases (applied, expired, not delivered, non-requiring, seed unavailable, forged on review, legacy); no log line carries the token         |
| Real gh                         | `broker-integration.test.ts`: real `gh api` with `GITHUB_TOKEN` = read token still reaches the gh broker with the bearer, and `gh auth token` prints only the bearer                                      |

**Rollback.** Clear the pack from Task agent packs, or drop `requires` from the manifest entry. Task
runs then get today's env (bearer in both `GH_TOKEN` and `GITHUB_TOKEN`).

## Amendment 2026-10-04 (phase 9) — self-heal fix lane

**What changes.** A self-heal FIX run (ADR-010 part 2) must push a branch. It gets no GitHub write
credential for that. Its only write path is the fenced git broker on the worker:

- The run is refused before the clone unless the box runs the credential broker
  (`WORKER_CREDENTIAL_BROKER=on`). Under `legacy-direct` the agent would hold the raw installation
  token and bypass the fence.
- The broker parses the receive-pack command list and forwards a push only when every update targets
  the run's own `refs/heads/automata/fix-*` branch. A delete, any other ref, a malformed list or a
  compressed body is refused before a byte reaches GitHub (`receive-pack-refs.test.ts`,
  `git-broker.test.ts`, `broker-integration.test.ts`).
- gh stays on the gh broker, and nothing else in the fix agent's environment can write. The control
  plane opens, readies and closes the pull request with the App installation client; it never merges.

**The gate token is not a GitHub credential.** The per-attempt gate token authenticates exactly one
POST of the worker's finding-check verdict to `/api/self-heal/fix-check`. It is minted at dispatch,
stored as a sha256, expires after 2 hours, and is accepted once. It reaches the worker only, never
the daemon environment, argv or the journal (`daemon-env.test.ts`, `fix-check/route.test.ts`,
`self-heal-acceptance.test.ts`). It grants nothing on GitHub.

**The review lane is unchanged.** Review runs hold no GitHub credential, and the fix PR's single
review comes from the same review automation, triggered by the App's ready-for-review transition.
The invariant of this ADR stands: no write credential reaches an agent.

**Rollback.** Turn the `selfHealLoop` flag off and disable the audit-fix automations (runbook,
"Audit self-healing loop — fix loop (phase 9)"). No fix run starts after that.

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
