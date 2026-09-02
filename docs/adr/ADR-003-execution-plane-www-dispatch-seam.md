# ADR-003: Execution-plane integration — the www→Hatchet dispatch seam

- **Status:** Accepted (2026-07-17 — reviewed and approved by the platform-convergence lead;
  all three forks confirmed, two endpoint-hardening notes added)
- **Date:** 2026-07-17
- **Context source:** ADR-002 (per-org execution plane, rev 2), the chassis daemon protocol
  (`packages/daemon`, `apps/www/src/app/api/daemon-event/route.ts`), the boot seam
  (`apps/www/src/agent/msg/startAgentMessage.ts`), the live C8 boundary from the 2026-07-17 E2E
  (boot reached `queued→booting` then stopped at "no execution plane on Workers").
- **Deciders:** operator + platform-convergence program
- **Relates to:** ADR-002 (the execution *topology* + credential-placement rules — this ADR is
  the *dispatch seam* that hands work to it), ADR-001 (tenant scoping — the daemon token is
  org-scoped by that work).
- **Supersedes / superseded by:** —

## Context

ADR-002 established a shared control plane (`apps/www`, on Cloudflare Workers for the pilot) and a
per-org execution plane on customer-supplied infrastructure, coordinated by Hatchet. What it did
**not** specify is the *seam*: how a booting thread in www actually starts an agent on a remote
worker instead of the in-process sandbox provider — and how it does so without shipping any
long-lived secret off the control plane.

The load-bearing insight (operator): **the chassis's own daemon protocol already IS the worker
interface.** Today `startAgentMessage` boots an in-process sandbox, then `sendDaemonMessage`
mints an org-scoped API key (the "daemon token") and PUSHES a `DaemonMessage` (prompt, model,
agent, sessionId, permissionMode, featureFlags, token) to the daemon over the sandbox session
transport. The daemon runs the agent and POSTs structured events back to www
`/api/daemon-event` with that token as `X-Daemon-Token` (org-scoped since the batch-1 tenancy
work). A Hatchet worker on the customer box that clones the repo and runs `packages/daemon`
pointed at www is therefore **mostly chassis-native plumbing, not new invention** — the
daemon-event ingestion does not care where the daemon runs.

One thing genuinely changes. Today www *pushes* the message to the daemon over the sandbox
session. **www cannot push to a daemon on a customer box** (no session transport; the box is not
addressable from www — for the pilot www-on-Workers reaches the engine through a cloudflared
tunnel, one-way). So the message must be *pulled*.

## Decision

Add a **flag-gated dispatch seam** in the www boot path. Behavior is byte-identical to today when
no `HATCHET_*` env is set (nullable-safe; ADR-002 rollout order); when the execution plane is
configured, the same booting thread dispatches to Hatchet instead of the in-process sandbox.

### 1. The seam (`startAgentMessage`)

When `env.HATCHET_ENABLED` is true (or the thread's `sandboxProvider === 'hatchet-remote'`), the
`withSandboxResource` branch that today calls `createSandboxForThread` / `getSandboxForThreadOrNull`
+ `sendDaemonMessage` is replaced by a **dispatch to Hatchet**. Specifically www:

- **(a)** mints a **short-lived, installation-scoped GitHub token** for the thread's repo
  (`getInstallationToken(owner, repo)` — the existing seam; ADR-002 §3: the App private key
  **never** leaves the control plane);
- **(b)** mints the **per-thread daemon token** — the existing `auth.api.createApiKey` path in
  `sendDaemonMessage`, org-scoped via `metadata.organizationId`, short expiry;
- **(c)** triggers the Hatchet **`agent-run`** workflow (ADR-003 §2) with **reference-only input**
  `{ threadId, threadChatId, repoFullName, branch, daemonCallbackUrl }` plus the two short-lived
  tokens as step input. **No long-lived secret, no App key, no master key** is ever in the input;
- **(d)** leaves **thread status semantics unchanged** — the thread is already transitioned to
  `booting` before this point, and from here the daemon events drive the rest **exactly like a
  sandbox boot**. `system.boot` has already fired; the daemon's events (`running`, tool calls,
  `complete`/`error`) arrive at `/api/daemon-event` and move the state machine as they do today.

`daemonCallbackUrl` is www's own configured public base URL (env; on Workers the deploy/custom
domain). The worker reaches www there through the tunnel.

### 2. Message delivery — the worker PULLS the `DaemonMessage`

Because www cannot push, and the workflow input is deliberately reference-only, the worker's
daemon **fetches** its `DaemonMessage` from www. Add one www endpoint:

`POST {daemonCallbackUrl}/api/daemon/next-message` with `{ threadId, threadChatId }` in the body
(F5 — the enumeration key stays off the URL) — authenticated by the daemon
token (same `X-Daemon-Token` custody as the event ingestion), returns the prepared message
`{ prompt, model, agent, agentVersion, sessionId, permissionMode, featureFlags }` for that
threadChat. www builds it with the **same** logic `startAgentMessage` uses today
(`getUserMessageToSend` → `preparePromptForModel` → compaction), factored into a shared function.

**Endpoint hardening (lead notes, mandatory):**

- **(H1) Assert the token↔thread binding, not just token validity.** The daemon token resolves to
  `{ userId, organizationId }` (its API-key metadata). The endpoint MUST load the requested
  `threadChatId`'s thread and assert **both** that thread's `userId` matches the token's user
  **and** its `organizationId` matches the token's org — a *valid* daemon token for a *different*
  thread/org must be rejected (403), not served. Tested explicitly.
- **(H2) The response body is sensitive.** It carries the prompt (repo content + user text).
  **Never log the body.** Structure the handler so a future access log can record
  `key`/`threadChatId`/`org` — never content. (Same reason the prompt is kept out of the workflow
  input; see fork 3.)

- **Symmetry:** the daemon already authenticates to www with this token for events; reading its
  own next message is the same custody, no new secret.
- **Input hygiene:** Hatchet persists workflow input; keeping the (large, mutable) prompt out of
  it and behind an authenticated pull is cleaner than embedding it.
- **Pilot-scope limitation (documented, not blocking):** `preparePromptForModel` today writes
  image attachments to the sandbox *session* (`session.writeFile`). www has no session in the
  remote path, so **pilot v1 serves text-only prompts** (the mirror-intake / PR-review tasks are
  text). Image-attachment support = follow-up: the worker fetches attachments from R2 by key
  (the keys are already in the message) and writes them into its workdir. Called out so it
  surfaces as a known gap, not a silent truncation.

### 3. Token custody (ADR-002 §3, restated for this seam)

- App private key: **control plane only.** The worker receives an installation-scoped token that
  expires; a compromised worker holds an expiring token for its own org's repos, nothing more.
- Daemon token: short-lived, **org-scoped** better-auth API key; authorizes daemon→www events and
  the next-message pull, fenced to the thread's org **and** — after the validator findings below —
  to the specific threadChat and the daemon purpose.
- Anthropic credential: **the org's own, in the worker's env on the box** — never transits www or
  the workflow input (ADR-002 §2/§3). The daemon uses `agent=claude` with the worker box's
  `ANTHROPIC_API_KEY`.

**Validator findings folded into slice 1 (adversarial §3 read, 2026-07-17).** The daemon token as
originally built was **weaker than §3 above claimed** — it was a *general* better-auth API key
that the CLI router (`cli-router.ts`) also accepted, so a compromised box could call
`threads.list/detail/CREATE` (full CLI + agent-spawn), not just "post its own thread's events".
Corrected here:

- **F1 (purpose scope).** The mint stamps `metadata.tokenType = 'daemon'`. The **CLI router now
  REJECTS** daemon-scoped tokens; the **daemon endpoints require** them. Blast radius of a leaked
  daemon token is now bounded to one thread's daemon protocol, matching the §3 claim.
- **F2 (thread binding, mandatory).** The mint stamps `metadata.threadChatId`. **Both**
  `/api/daemon-event` **and** `/api/daemon/next-message` assert the token's `threadChatId` matches
  the request — an org-scoped token can no longer pull or inject for *any* thread in the org, only
  its own. (Legacy tokens minted without a `threadChatId` are allowed through `/api/daemon-event`
  during the rollout window; new tokens always bind.)
- **F3 (task-scoped lifetime).** The token is **revoked on thread-terminal** — `handleThreadFinish`
  (the daemon-event terminal handler) deletes the run's daemon token(s) by `name = sandboxId`.
  Revocation is the task-scoping mechanism; effective lifetime = task duration. Expiry stays at the
  better-auth apiKey plugin's **1-day minimum** as a backstop for a run that never reaches terminal
  (the plugin rejects an `expiresIn` below its minimum; lowering the backstop needs a plugin
  `keyExpiration` config change — deferred, not load-bearing since revocation is primary).
- **F4 (tokens in Hatchet step input) — ACCEPTED RISK for single-org pilot v1.** The short-lived
  installation + daemon tokens are passed as workflow step input, which Hatchet persists in its
  Postgres. Accepted because both are short-lived and org-scoped and the pilot is single-org.
  **Trigger to revisit:** before **any non-single-org deployment**, move token delivery to
  Hatchet secret-injection (out of persisted input). The *prompt* is never in the input regardless
  (fork 3) — only these expiring tokens are.
- **F5 (enumeration key off the wire).** `/api/daemon/next-message` is **POST with `threadChatId`
  in the body**, not a query param, so the enumeration key stays out of URLs and access logs. The
  worker side must likewise not log the pulled body (H2).

### 4. `packages/worker` — the `agent-run` workflow (ADR-003 §2, built after the seam)

Plain Node 22 on the customer box (no workerd constraints — `node:sqlite` etc. are fine). Steps:

- **provision** — clone `repoFullName`@`branch` into a fresh workdir using the installation token
  as `x-access-token:<token>` over HTTPS.
- **run** — spawn the chassis daemon (`packages/daemon`) pointed at `daemonCallbackUrl` + daemon
  token; the daemon pulls its message (§2), runs the agent (`agent=claude`, worker-box Anthropic
  key), and POSTs events to `/api/daemon-event` as today.
- **cleanup** — remove the workdir on any terminal state.

`ScheduleTimeout` 30m+; step timeouts hour-scale (agent runs are long). Reuse `packages/daemon`
and `packages/sandbox` code where importable.

## Design forks — RESOLVED (lead rulings 2026-07-17, with reasons)

1. **Daemon sandboxing on the box — bare workdir vs Docker. → BARE workdir for pilot v1**
   confirmed; Docker provider next. Reason: fastest path to a real run; the box is single-tenant
   per ADR-002, so the isolation ADR-002 buys is at the *box* boundary, not per-task. Revisit
   before multi-repo / untrusted-PR execution hardening.
2. **How the worker learns www's base URL. → per-task `daemonCallbackUrl` reference field**
   confirmed; **no worker-pinned URLs.** Reason: the control plane tells the worker where to call
   back per task, so www can move (deploy URL / custom domain) without reconfiguring every box.
3. **Message delivery: pull-endpoint vs prompt-in-input. → PULL-ENDPOINT** confirmed. Reason (the
   decisive one, and it is not code volume): **Hatchet persists workflow payloads in its Postgres.**
   The reference-only-input rule exists precisely to keep prompts — repo content and user text —
   **out of durable third-plane storage.** Embedding the `DaemonMessage` in the input would violate
   that. The short-lived, installation-scoped GitHub token in the input is the **ADR-002-sanctioned
   exception** (it expires and is scoped to one org's repos); a prompt is not. This is the same
   principle as endpoint hardening H2 (the prompt body is sensitive).

## Options considered

- **Dispatch inside `startAgentMessage` (chosen)** vs a separate dispatcher service. Chosen: the
  boot path already owns rate-limit/queue gating, the `booting` transition, and message prep;
  splitting it would duplicate that. The flag branch is small and local.
- **Pull next-message (chosen)** vs push (impossible for a remote box) vs prompt-in-input (viable,
  see fork 3).
- **Reuse the daemon token for the pull (chosen)** vs a distinct read token. Chosen: same custody,
  fewer moving parts.

## Consequences

- **Positive:** the remote execution path reuses the daemon protocol end-to-end; the daemon-event
  state machine, org scoping, and status semantics are unchanged. Flag-off = today exactly. No
  secret leaves the control plane. The seam is a small, testable branch.
- **Negative / watch:** pilot v1 is text-prompt-only (image attachments deferred). A new
  authenticated www endpoint (`/api/daemon/next-message`) widens the daemon-facing surface — it
  must enforce the same org fence as `/api/daemon-event`. The `booting`→terminal path now depends
  on the worker actually connecting; ADR-002's `SCHEDULING_TIMED_OUT` / min-version-gate concerns
  apply (a thread stuck `booting` because no worker registered `agent-run` must surface, not hang).

## Rollout order

1. Seam refactor: factor message-prep into a shared function; add the flag branch + the
   `/api/daemon/next-message` endpoint. Flag-off proven identical. (This slice.)
2. `packages/worker` `agent-run` workflow against boot-coder's hello-world substrate.
3. Wire the tunnel + register the worker; live C8 run.

## Testing

- **Seam unit tests:** flag on → Hatchet trigger called once with reference-only payload +
  the two short-lived tokens, and **no App key / master key** anywhere in the input; the in-process
  sandbox provider is **not** called. Flag off → the in-process path runs unchanged (existing
  `startAgentMessage` tests stay green).
- **next-message endpoint:** daemon-token auth required; org fence enforced; returns the same
  prepared message the in-process path would have sent.
- **Workflow step tests:** provision/run/cleanup against a mocked Hatchet context + a mocked
  daemon; installation token used for clone; workdir removed on terminal.

## Amendment (2026-09-02, ADR-007 / #165)

The seam **dispatches and stamps; it never cancels prior runs**. The pre-#165 app-side
cancel pass (`supersedePriorReviewRuns`) and the automation's prior-thread archival are
deleted; supersession of prior review runs is engine-only (the policy variant's per-PR
concurrency), reconciled by the C4 sweep. See ADR-007.
