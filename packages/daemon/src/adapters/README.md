# HarnessAdapter contract

This directory is the one-file-per-CLI boundary for adding or changing a coding-agent harness
(claude / codex / gemini / amp / opencode). It replaces the old `daemon.ts` dispatch switch and
five ~70%-duplicated `run*Command` methods (ADR-006).

Delivered by: #75 (contract + golden-test pair), #76 (cutover of `daemon.ts` to the single generic
`runAgentCommand`), #77 (`AUTH_FILE_BY_AGENT` single source of truth), #88 (per-harness
`reviewPolicyArgs()` + OpenCode review-mode plugin fix) — all part of epic #70.

**Open gap:** ADR-004's on-disk credential channel (`~/.git-credentials` written unconditionally by
`setupGitCredentials`) is **not** closed by this contract. Tracked by #89. See "SHAPE-not-KIND" below
for what this contract _does_ guarantee, and ADR-004's "Amendment 2026-08-21 (#88)" for what it does
not.

> **This document describes THIS repository's pattern.** The repo-adjacent `create-agent-adapter`
> skill describes how to build a **Paperclip** agent adapter — a different project, with a different
> package-per-adapter / three-consumer (server/ui/cli) architecture
> (`packages/adapters/<name>/{server,ui,cli}`). None of that structure applies here. If you were
> routed to that skill while working in `automata-platform`, ignore it and follow this doc instead.

## 1. The `HarnessAdapter` contract

Defined in [`types.ts`](./types.ts). One object per harness, registered in
[`registry.ts`](./registry.ts):`harnessAdapterRegistry: Record<AIAgent, HarnessAdapter>`. `daemon.ts`'s
`runAgentCommand` (daemon.ts:620-751) reads only the registry — no method on `TerragonDaemon`
branches on agent identity.

| Field                   | Type                                                         | What it does                                                                                                                                                        | Constraints                                                                                                                                                                                                                                                                                                                                                                    | Pinned by                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent`                 | `AIAgent`                                                    | Identity key into the registry.                                                                                                                                     | —                                                                                                                                                                                                                                                                                                                                                                              | `registry.ts:15-21` (`Record<AIAgent, HarnessAdapter>` — missing a key is a compile error)                                                                   |
| `displayName`           | `string`                                                     | Exact `agentName` string passed to `spawnAgentProcess` / logging.                                                                                                   | Must match the value the old per-agent method used (e.g. `"Claude"`, `"Opencode"`).                                                                                                                                                                                                                                                                                            | `adapter-golden.test.ts:410-416`                                                                                                                             |
| `authFilePath()`        | `() => string \| null`                                       | Path (relative to the run's HOME) of the on-disk credential file for this agent, or `null` if none.                                                                 | Sourced from the single shared map `AUTH_FILE_BY_AGENT` (`packages/agent/src/auth-file.ts`, #77) — do not hardcode a path in the adapter.                                                                                                                                                                                                                                      | `adapter-golden.test.ts:111-114,150` (claude/codex path literals); `auth-file.test.ts` (map itself)                                                          |
| `prepareEnv(ctx)`       | `(PrepareEnvContext) => Record<string, string \| undefined>` | Builds the child-process env for this agent's spawn.                                                                                                                | `ctx` is intentionally narrow — see §2. Must never accept a credential kind, `userId`, or `organizationId`.                                                                                                                                                                                                                                                                    | `adapter-golden.test.ts` (per-adapter `prepareEnv` cases); `daemon-golden.test.ts` (socket-level env assertions)                                             |
| `buildArgs(cfg)`        | `(BuildArgsConfig) => string`                                | Builds the full shell command string (`cat <promptfile> \| <cli> ...`).                                                                                             | `BuildArgsConfig` is the union of every `*Command()` builder's params (`types.ts:50-59`).                                                                                                                                                                                                                                                                                      | `adapter-golden.test.ts` (`EXPECTED_*_COMMAND*` literals in `__golden-fixtures.ts`); `daemon-golden.test.ts` (same literals, driven through the real socket) |
| `normalizeModel(model)` | `(string) => string`                                         | Model-string rewriting hook. Identity (`(m) => m`) for every adapter today.                                                                                         | Existing per-CLI model rewrites (opencode's legacy `opencode/` → `terry/` prefix, opencode.ts:312-326; codex's 30-case model switch inside `codexCommand`, codex.ts:258-363) stay **inside** the existing builder and are **not** hoisted here — applying either twice would double-apply.                                                                                     | `adapter-golden.test.ts:113` (claude identity check); command-string goldens above indirectly exercise the builders' internal rewrites                       |
| `makeLineParser(ctx)`   | `(MakeLineParserContext) => HarnessLineParser`               | Constructs a per-run stdout-line parser: `parse(line, callCtx) => ClaudeMessage[]`, optional `finalize() => ClaudeMessage[]`.                                       | `ParseLineCallContext.isWorking` must be read at **call** time, not parser-construction time (opencode's `step_start` handling changes behavior line-to-line within the same stdout batch, daemon.ts:664-666 snapshots it fresh per line). `finalize` is for harnesses that must flush accumulated state on process close (gemini only, for `parserState.accumulatedContent`). | `adapter-golden.test.ts:195-223` (gemini `finalize` flush + double-call no-op), `:247-268` (opencode call-time `isWorking`)                                  |
| `capabilities`          | `HarnessCapabilities`                                        | Declares the security/behavior flags the generic runner needs to reproduce this harness byte-identically. See §1.1.                                                 | —                                                                                                                                                                                                                                                                                                                                                                              | `adapter-golden.test.ts:398-417`; `daemon-golden.test.ts` (review-mode five-agent loop, is_error flush, session-tracking cases)                              |
| `reviewPolicyArgs()`    | `() => string[]`                                             | Best-available extra CLI args composed into `buildArgs` output when `permissionMode === "review"`, via the shared `reviewPolicyArgsFor` helper (`shared.ts:48-53`). | Additive defense-in-depth, **not** the hard guarantee (that's `withholdGitCredentialsInReviewMode`). An adapter that cannot verify a safe restriction against its pinned CLI version **must** return `[]` and document the verification attempt + reason in its own file's JSDoc — see §1.2.                                                                                   | `adapter-golden.test.ts:69-84` (claude non-empty pin), `:271-365` (four `[]`-shipping adapters, table-driven)                                                |

### 1.1 `HarnessCapabilities` — the 5×N matrix

Defined in `types.ts:124-130`. Current values across all five adapters:

| Agent                            | `withholdGitCredentialsInReviewMode` | `mockSuccessResult`                 | `fixesSessionLogs` | `flushBufferOnErrorResult` | `sessionTracking`             |
| -------------------------------- | ------------------------------------ | ----------------------------------- | ------------------ | -------------------------- | ----------------------------- |
| claude (`claude-adapter.ts`)     | `true`                               | —                                   | `true`             | —                          | `"any-message"`               |
| codex (`codex-adapter.ts`)       | `true`                               | `"Codex successfully completed"`    | —                  | `true`                     | `"system-init-with-backfill"` |
| gemini (`gemini-adapter.ts`)     | `true`                               | —                                   | —                  | —                          | `"system-init-with-backfill"` |
| amp (`amp-adapter.ts`)           | `true`                               | —                                   | —                  | —                          | `"none"`                      |
| opencode (`opencode-adapter.ts`) | `true`                               | `"Opencode successfully completed"` | —                  | —                          | `"system-init-with-backfill"` |

`withholdGitCredentialsInReviewMode` is **mandatory `true` for every adapter** — it is the ADR-004
hard guarantee (env-strip half), read uniformly by `daemon.ts`'s `runAgentCommand`
(`withholdGitCredentials: input.permissionMode === "review" && adapter.capabilities.withholdGitCredentialsInReviewMode`,
daemon.ts:636-638). `adapter-golden.test.ts:398-409` asserts this for the whole registry in one loop,
so a new adapter that ships `false` (or omits the field, which fails to typecheck) fails that test
immediately.

`fixesSessionLogs` and `flushBufferOnErrorResult` are single-agent flags (claude and codex
respectively) — do **not** generalize them: `daemon.test.ts` pins that Claude's `is_error` result does
NOT trigger codex's flush behavior (types.ts:110-115).

`sessionTracking` has three values, branched on directly in `daemon.ts:674-697` — they are
intentionally **not** unified into one policy (Gap C, the highest-risk per-agent divergence called out
in the code comment at daemon.ts:672-673):

- `"any-message"` — any message carrying a `session_id` sets it, no backfill (claude only).
- `"system-init-with-backfill"` — only a `type: "system"` message with a `session_id` sets it;
  `assistant`/`user` messages get backfilled from the current snapshot (codex, gemini, opencode).
- `"none"` — the tracked session/isWorking state is never touched by parsed messages (amp only).

### `reviewPolicyArgs()` status per agent (#88, ADR-004 amendment)

| Agent    | Pinned CLI version     | Outcome                  | Reason (full detail in the adapter's builder file JSDoc)                                                                                                                                     |
| -------- | ---------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| claude   | 2.0.65 / 2.1.235       | Shipped, non-empty       | `--permission-mode default` + `--disallowedTools` for `gh`/`git push` + `--setting-sources user` (`claude.ts`'s `reviewPolicyArgs`)                                                          |
| codex    | 0.76.0                 | `[]`                     | `--sandbox read-only` rejected: unreliable inside containers without `SYS_ADMIN`, and doesn't block network anyway (`codex.ts`'s `codexReviewPolicyArgs` JSDoc)                              |
| gemini   | 0.20.0                 | `[]`                     | Dropping `--yolo` breaks the non-interactive scheduler (`ToolErrorType.CONFIRMATION_REQUIRED`); the allowlist flag is deprecated/unverifiable (`gemini.ts`'s `geminiReviewPolicyArgs` JSDoc) |
| amp      | 0.0.1765471542-g74e231 | `[]`                     | No verified CLI-argument restriction surface; amp's permission controls are `settings.json` keys, not `amp exec` flags (`amp.ts`'s `ampReviewPolicyArgs` JSDoc)                              |
| opencode | 1.0.149                | `[]` (args) + plugin fix | Args are the wrong seam; the real fence is the mode-aware `permission.ask` plugin, driven by the `TERRAGON_REVIEW_MODE` env marker `opencodeAdapter.prepareEnv` sets in review mode          |

Golden-pinned in `__golden-fixtures.ts:95-108` (`EXPECTED_*_REVIEW_POLICY`,
`EXPECTED_*_COMMAND_REVIEW`) and asserted in `adapter-golden.test.ts:271-365`.

### 1.2 Worked walkthrough: adding a new CLI

Adding a hypothetical sixth harness (call it `foo`) is:

1. **One adapter file**, `foo-adapter.ts`, implementing `HarnessAdapter` (see any existing
   `*-adapter.ts` as a template — they are thin façades over an existing `foo.ts` command/parser
   module, not new logic).
2. **One registry line** in `registry.ts`'s `harnessAdapterRegistry` map. `AIAgent` (from
   `@terragon/agent/types`) must gain the `"foo"` member first — `Record<AIAgent, HarnessAdapter>`
   then forces the new key at compile time; there is no runtime default case to remember.
3. **The auth-file map entry decision**, in `packages/agent/src/auth-file.ts`'s
   `AUTH_FILE_BY_AGENT: Record<AIAgent, string | null>`. This is not optional busywork: the map's own
   exhaustiveness test (`auth-file.test.ts:17-26`, `for (const agent of AIAgentSchema.options) expect(...).toBe(true)`)
   fails to compile/run until `foo` has an entry — either a real on-disk path (if `foo` has a
   file-based credential) or an explicit `null` (if it doesn't, per the gemini/amp/opencode
   precedent, which is permanent, not a TODO — see the map's JSDoc).
4. **Golden tests, at both levels** (the byte-identical proof described in `__golden-fixtures.ts`'s
   header comment):
   - **Adapter-level** (`adapter-golden.test.ts`): call `fooAdapter.buildArgs` / `.prepareEnv` /
     `.capabilities` / `.makeLineParser` directly (no daemon, no socket) and assert against literals
     added to `__golden-fixtures.ts` — the same file both test levels import from, so they can never
     independently drift.
   - **Daemon-level** (`daemon-golden.test.ts`): drive the real daemon over the unix socket with a
     `DaemonMessageClaude` carrying `agent: "foo"` and assert `runtime.spawnCommandLine`'s captured
     command string + env match the **same** `__golden-fixtures.ts` literals.
5. **The review-fence obligations** (ADR-004 / ADR-006):
   - `capabilities.withholdGitCredentialsInReviewMode` **must** be `true`. This is not a default —
     omitting it fails to typecheck (`HarnessCapabilities.withholdGitCredentialsInReviewMode` is
     required, not optional), and `adapter-golden.test.ts:398-409` asserts it across the whole
     registry, so a new adapter that ships `false` fails immediately.
   - `reviewPolicyArgs()` is **best-available, not best-effort-skippable**. Attempt to find a real
     CLI-argument restriction against `foo`'s **pinned** version in
     `packages/sandbox-image/Dockerfile.hbs`. If one exists and is verified safe (does not hang or
     break the run), ship it and pin its exact joined-args string in
     `__golden-fixtures.ts`/`adapter-golden.test.ts`, following claude's pattern. If none can be
     verified safe, return `[]` **and** write the verification attempt + reason in `foo.ts`'s
     `fooReviewPolicyArgs()` JSDoc — following the codex/gemini/amp/opencode pattern — so the next
     reader sees what was tried, not silence.

No daemon.ts change is required for any of the above — `runAgentCommand` (daemon.ts:620-751) is
already generic over the registry.

## 2. The SHAPE-not-KIND hard line

**The boundary:** everything in this directory — every `HarnessAdapter` method — may branch on
**agent identity** (`AIAgent`: `claudeCode | codex | gemini | amp | opencode`) and the **credential
SHAPE** already resolved onto the daemon wire message (`token`, `useCredits`, `permissionMode` —
`DaemonMessageClaudeSchema`, `shared.ts:17-32`). It may **never** branch on, or accept, a credential
**KIND** (`AIAgentCredentials`: the `env-var | json-file | built-in-credits` union), a `userId`, or an
`organizationId`.

- **Where KIND resolution stays:** `apps/www/src/agent/credentials.ts`'s `getAndVerifyCredentials`
  (lines 31-121) is the control-plane function that resolves an `(agent, userId, organizationId)`
  triple into an `AIAgentCredentials` KIND — `{ type: "env-var", key, value }` (amp),
  `{ type: "json-file", contents }` (codex/claude when a stored credential exists),
  or `{ type: "built-in-credits" }` (codex/claude fallback, and always for gemini/opencode). This
  function is the ONLY place KIND resolution happens; nothing in `packages/daemon/src/adapters/`
  imports it or reasons about its return type beyond the `AIAgentCredentials` type re-export in
  `types.ts:17` (present only so adapter authors can read the shape in JSDoc — no method accepts it).
- **What crosses into this directory:** by the time a run reaches `packages/daemon`, the KIND has
  already been resolved (upstream, in `apps/www`) into the wire-level `token` / `useCredits` /
  `permissionMode` fields every `PrepareEnvContext` and `BuildArgsConfig` carries. `PrepareEnvContext`
  (`types.ts:28-47`) is documented as intentionally narrow and must **never** grow a `creds:
AIAgentCredentials`, `boxApiKey`, `userId`, or `organizationId` field.
- **Compile-level enforcement:** `types.test-d.ts` is a compile-only guard (never executed by
  vitest — its glob is `*.test-d.ts`, not matched by the default `*.test.ts`/`*.spec.ts` include) that
  asserts, via `// @ts-expect-error`, that none of `userId`, `organizationId`, a KIND-bearing `creds`
  field, or `boxApiKey` are assignable onto `PrepareEnvContext`. `pnpm -C packages/daemon tsc-check`
  type-checks this file on every run — a case that stops erroring (because a field was loosely added
  to `PrepareEnvContext`) fails the build with "Unused '@ts-expect-error' directive".
- **ADR:** ADR-006 (`docs/adr/ADR-006-shape-not-kind-agent-agnostic-harness.md`), decision 1 and the
  "Anti-deviation invariants" section: _"Nothing below the control plane may branch on credential
  kind, user, or org — only on the resolved shape and agent identity."_

## 3. Disclaimer: the `create-agent-adapter` skill is a different project

The repo-adjacent Claude Code skill `create-agent-adapter` ("Technical guide for creating a new
Paperclip agent adapter") describes **Paperclip**, not this repository. Paperclip's pattern is a
separate npm package per adapter (`packages/adapters/<name>/src/{index.ts,server,ui,cli}`) serving
three separate consumer registries (server execution, UI transcript parsing, CLI formatting) — an
entirely different shape from the single `HarnessAdapter` object + `harnessAdapterRegistry` map
described in this document. If that skill surfaces while you're working in `automata-platform`,
disregard its file layout, registration points, and conventions — they do not apply here. This
document is the source of truth for adding or modifying a coding-agent harness in this repo.
