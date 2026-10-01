# Spec — 209a: credential-source attribution on an agent run

> Ticket: Issue #209, **ITEM 1 ONLY**.
> Worktree: `/Users/senior/.superset/projects/automata-platform/.claude/worktrees/209a`
> Branch base: the worktree's current `main`-derived branch.
> Language: English (matches this repo's existing spec corpus, `docs/specs/152/refinement-report.md`).

---

## 0. Reality check — where the ticket text and the code disagree

Read this before anything else. Every claim below was verified by reading files in **this**
worktree today.

| # | Ticket says | Code actually says | Consequence for this spec |
|---|---|---|---|
| 1 | "an EXISTING json/meta column on the run or thread … the codebase already stores structured result data in thread meta" | There is **no `meta` column** on `thread` or `thread_chat`. `grep -n "meta" packages/shared/src/db/schema.ts` yields only `metadata` on `apikey` (`:126`, `:227`), `source_metadata` (`:439`) and `agent_provider_credentials.metadata` (`:1430`). The "structured result data in thread meta" is a **message variant inside the `messages` jsonb column**: `DBResultMetaMessage` = `{ type: "meta", subtype: "result-success", … }` (`packages/shared/src/db/db-message.ts:163-178`). | Storage route **(a) is still available**, but through `thread.messages` / `thread_chat.messages` (both `jsonb(...).$type<DBMessage[]>()`, `schema.ts:333` via `threadChatShared`), not through a column called `meta`. **No migration. No `deploy/assert-schema-ready.ts` change.** |
| 2 | — | `DBMetaMessage` already has a `{ subtype: "system-metadata"; content: string }` variant (`db-message.ts:166-169`). `grep -rn "system-metadata"` finds **exactly one hit — the type definition**. Nothing produces it, nothing renders it. | It is dead code. Reusing it would still require a producer and a renderer, and `content: string` is free text — the opposite of the "short enum-like label" the AC demands. **Rejected.** |
| 3 | "START BY READING `packages/worker/src/agent-run/www-client.ts` … where credentials are pulled and where the built-in-credits fallback is decided" | `pullAgentCredentials` (`www-client.ts:129-199`) does own *one* fallback (204 / non-OK → `CREDITS_ONLY`), but the **three-way divergence is in `workflow.ts`**: the boxTrust gate at `workflow.ts:516-518` (`config.boxTrust === "owner" ? await pullAgentCredentials(...) : built-in-credits`) and the three-arm expression at `workflow.ts:546-555` (`materialised.delivered` → `box-key` → credits proxy). | The attribution is **decided in `workflow.ts`**, next to the existing `step()` log that already names the three paths. `www-client.ts` (this ticket's owned file) gains only the HTTP **transport** function. |
| 4 | "surface it in the thread as one line" | There is **no existing endpoint that appends a message without moving the status machine.** `/api/daemon-event` routes through `handleDaemonEvent`, which ends in `updateThreadChatWithTransition({ eventType: "assistant.message", … })` (`handle-daemon-event.ts:558-576`), and `machine.ts:92` maps `booting --assistant.message--> working`. The worker posts its attribution **before** the agent has produced anything, while the thread is still `booting`. Reusing `/api/daemon-event` would therefore flip the thread to `working` early **and** null out `errorMessage`/`errorMessageInfo` (`handle-daemon-event.ts:352-353`). | A **new, narrow daemon route** is required. It is new API surface, not a new table. See §7 and `api-contract.md`. |
| 5 | — | `handleDaemonEvent` logs the entire inbound message array verbatim: `console.log("Daemon event", …, JSON.stringify(messages, null, 2))` (`handle-daemon-event.ts:77-88`). | Another reason not to route this through `/api/daemon-event`, and a standing reminder that anything on a daemon wire gets logged in full. Our payload is a three-value enum, so this is harmless — but it is harmless *by construction*, which is the point. |
| 6 | "Every agent run already knows … whether it took the delivered user credential, the built-in-credits path, or a box key" | **Confirmed.** `materialiseAgentCredentials` returns `delivered: boolean` (`agent-credentials.ts:26`, `:155`, `:166`, `:209`); `config.boxTrust` is `"owner" \| "shared" \| "box-key"` (`config.ts:58`, resolved at `config.ts:346-351`). | True as written. |
| 7 | — | Under `boxTrust=owner`, a credential **pull failure** (404 from an old control plane, transient 5xx, or 204) also yields `delivered=false` and therefore the *same* `built-in-credits` attribution as "the user has no credential" (`www-client.ts:184-196`). | Known limit. Not in scope — the DoD names exactly three paths. Recorded in §10 D7 and §"Open questions". |
| 8 | — | `@terragon/worker` does **not** depend on `@terragon/shared` (`packages/worker/package.json` deps: `@hatchet-dev/typescript-sdk`, `@terragon/agent`, `@terragon/daemon`, `pg`). The repo's established answer is a **structural mirror**: `TERMINAL_CAUSES` is duplicated in `packages/shared/src/model/terminal-cause.ts:10-19` and `packages/worker/src/agent-run/types.ts:105-115`, with a comment saying "never imported across the plane boundary" and an exhaustive-switch drift guard. | This spec follows that exact pattern rather than adding a cross-plane dependency. |
| 9 | — | The repo has **no i18n framework**. `grep -rn "next-intl\|useTranslations" apps/www/src` returns nothing; `apps/www/src/components/chat/chat-message.tsx:284-330` hardcodes English label strings in a `switch`. | §16 is "not applicable" and the copy lives in one shared label map. |

**Nothing in this spec assumes a dependency I have not opened in this worktree.** Every path,
line number and symbol above was read directly.

---

## 1. Objetivo / Goal

A user connected a Claude Code credential on the admin Agent Providers page. It read
**ENABLED**. Every run then died on `Credit balance is too low`, because the shared execution
box runs with `WORKER_BOX_TRUST=shared`, which forces the built-in-credits path and never
consults the user's credential at all. The credential was real, connected, and completely
inert. Establishing that took a query against the production database.

**Build:** at the exact point the execution plane chooses between the three credential paths,
capture which one it chose, persist it with the run, and render it in the thread as one line:

- `Credential: your connected Claude Code credential`
- `Credential: built-in credits`
- `Credential: this box's own API key`

**Outcome enabled:** a run whose credential source differs from what the user configured is
legible from the UI alone. The silent misroute becomes a readable fact. No database query.

**Explicitly NOT built:** any ability to *change* the credential source from the UI. This
ticket is read-only in that direction (§10 D1).

---

## 2. Alcance / Scope

### Incluido en esta fase

1. A three-value credential-source vocabulary, defined once per plane:
   `packages/shared/src/model/credential-source.ts` (control plane, with the user-facing copy)
   and a structural mirror in `packages/worker/src/agent-run/types.ts` (execution plane).
2. A pure `resolveCredentialSource({ boxTrust, credentialDelivered })` in
   `packages/worker/src/agent-run/workflow.ts`, called **once**, at the branch that already
   decides this (`workflow.ts:546-555`).
3. `postRunCredentialSource(...)` in `packages/worker/src/agent-run/www-client.ts` — a
   never-throwing POST, in the shape of the existing `postRunFailed` / `postEgressEvents`.
4. A new control-plane route `POST /api/daemon/run-credential-source` that validates the enum
   with `zod`, applies the #125 C1 generation fence, and appends **one** message to the
   thread's existing `messages` jsonb — with **no status transition**.
5. A new `DBMessage` variant `{ type: "credential-source"; source; timestamp? }` plus its
   `UISystemMessage` mapping, and a one-line renderer in the chat transcript.
6. Tests: three distinct attributions at the branch point; absent attribution renders nothing;
   the persisted value contains no secret material (asserted, not assumed).

### Fuera de scope (exhaustive)

- **#209 item 2** — making the admin credentials page show effective rather than stored state.
  Separate ticket, not hardened. **If you find yourself editing the admin credentials page,
  you have left this ticket.**
- **#209 item 3** — per-box trust control. Gated on #193's dedicated boxes.
- Any user-facing or API-facing control that **writes** `WORKER_BOX_TRUST`. Forbidden (§10 D1,
  §14).
- Any **schema migration**: no new column, no change to `packages/shared/src/db/schema.ts`,
  no change to `deploy/assert-schema-ready.ts`. (§10 D2 explains why, and what would change if
  that decision were ever reversed.)
- Changing which credential a run uses. `resolveUseCredits` (`workflow.ts:117-148`) and the
  `boxTrust` gate (`workflow.ts:516-518`) keep their behaviour **byte for byte**. This ticket
  only *reports*.
- Backfilling attribution onto runs that predate this change. They render nothing, forever
  (§10 D5).
- Persisting *why* the credential was not delivered (pull 404 vs 5xx vs "user has none") —
  §0 row 7, §10 D7.
- Any new chip in `run-status-chip.tsx`, any change to `thread.terminalCause` / C5 chips.
- The in-sandbox daemon path (E2B/Docker provider threads). Only the remote execution plane
  (`@terragon/worker`) knows `boxTrust`; an in-sandbox run posts nothing and renders nothing.
- Observability beyond the existing `console.*` lines (no new metric, no PostHog event).
- Any retry/queueing for the attribution POST. One attempt, fail-soft (§10 D6).
- i18n plumbing (none exists — §0 row 9).

---

## 3. Tecnologías y convenciones / Technologies & conventions

| Thing | Version / location | Source |
|---|---|---|
| Package manager | pnpm 10.14.0 | root `package.json:20` |
| Monorepo task runner | turbo (`pnpm turbo …`) | root `turbo.json` |
| TypeScript | 5.8.3 (pinned in root `pnpm.overrides`) | root `package.json:42` |
| Next.js | 15.5.25 (App Router) | root `package.json:37`, `apps/www/package.json:97` |
| React | 19.1.2 | root `package.json:40` |
| Drizzle ORM | ^0.45.2 | `packages/shared/package.json:46` |
| zod | 4.1.11 | `packages/shared/package.json:50`, `apps/www/package.json:128` |
| Vitest | 3.1.4, always `--no-file-parallelism` | root `package.json:44`; `apps/www/package.json:11`, `packages/shared/package.json:9`, `packages/worker/package.json` (`"test": "vitest --no-file-parallelism --passWithNoTests"`) |
| www test runner config | `apps/www/vite.config.ts` (there is **no** `vitest.config.ts` in `apps/www`) | verified by `ls apps/www` |

### Existing patterns this change must respect

- **Cross-plane vocabulary is mirrored, never imported.** `TERMINAL_CAUSES` exists twice —
  `packages/shared/src/model/terminal-cause.ts:10-19` and
  `packages/worker/src/agent-run/types.ts:105-115` — with an exhaustive switch
  (`describeTerminalCause`) on each side as the drift guard, and a test
  (`packages/worker/src/agent-run/types.test.ts`) that asserts the tuple length and that an
  unknown value throws. **Copy this shape exactly.**
- **Daemon routes use `parseDaemonRequest`** (`apps/www/src/lib/daemon-route.ts`): 401 on no
  token, 403 on a non-`daemon` token, 400 on a zod failure, 403 on an F2 thread/threadChat
  binding mismatch. Every sibling route under `apps/www/src/app/api/daemon/` uses it.
- **The generation fence** (`checkThreadGeneration`, `packages/shared/src/model/threads.ts:1147`)
  is applied by `run-terminal/route.ts:47-51`; `runExternalId: null` **fails open** by design
  (`decideThreadGeneration`, `threads.ts:1106-1143`).
- **Worker→www posts never throw.** `postRunFailed` (`www-client.ts:217-269`) and
  `postEgressEvents` (`www-client.ts:388-417`) both catch the request error *and* the non-2xx,
  log, and return. The new post follows that contract to the letter.
- **Message append without a transition** is `updateThreadChat({ updates: { appendMessages } })`
  (`packages/shared/src/model/threads.ts:917-1041`) — it handles the legacy-thread vs
  thread_chat split, sanitises for JSON, and publishes the realtime broadcast. It does **not**
  touch status.
- **TypeScript conventions:** `.claude/rules/typescript/best-practices.md` — kebab-case
  filenames, `interface` for object shapes / `type` for unions, literal unions instead of
  enums, `??` not `||`, `async`/`await` only, catch `unknown` and narrow with
  `instanceof Error`, never log secrets.

---

## 4. Dependencias previas / Prerequisites

Tick each before writing code. Each was verified present in this worktree on 2026-09-30.

- [x] `packages/worker/src/agent-run/workflow.ts` exposes the three-way credential branch at
      `:516-518` (boxTrust gate) and `:546-555` (the `step()` that names all three paths).
- [x] `materialiseAgentCredentials` returns `{ delivered: boolean, … }` —
      `packages/worker/src/agent-run/agent-credentials.ts:26`.
- [x] `WorkerConfig.boxTrust: "owner" | "shared" | "box-key"` —
      `packages/worker/src/agent-run/config.ts:58`, resolved at `:346-351`.
- [x] `WwwClientOpts` already carries `baseUrl`, `daemonToken`, `threadId`, `threadChatId`,
      `traceparent?`, `runExternalId?`, and `headers()` already emits `x-run-external-id`
      (`www-client.ts:14-48`).
- [x] `parseDaemonRequest` exists — `apps/www/src/lib/daemon-route.ts`.
- [x] `checkThreadGeneration` exists and tolerates `runExternalId: null` —
      `packages/shared/src/model/threads.ts:1147-1169`.
- [x] `updateThreadChat` supports `appendMessages` with no status change —
      `packages/shared/src/model/threads.ts:917`.
- [x] `thread.messages` and `thread_chat.messages` are `jsonb().$type<DBMessage[]>()` —
      `packages/shared/src/db/schema.ts:333` (via `threadChatShared`), shared by both tables.
- [x] `toUIMessages` + `UISystemMessage` + the `SystemMessage` renderer exist —
      `apps/www/src/components/chat/toUIMessages.ts`,
      `packages/shared/src/db/ui-messages.ts:30-44`,
      `apps/www/src/components/chat/chat-message.tsx:284-343`.
- [x] www/shared test suites boot a throwaway Postgres via docker compose (see the route test
      `apps/www/src/app/api/daemon/run-terminal/route.test.ts`, which writes real rows through
      `@terragon/shared/model/test-helpers`).
- [ ] **Docker Desktop is running on the machine** (needed by the www + shared suites) and the
      verification command is run with `dangerouslyDisableSandbox: true` (§8).

**No prerequisite is assumed.** If the implementer finds any `[x]` above to be false, stop and
report it rather than working around it.

---

## 5. Arquitectura / Architecture

### Pattern

**Decide-once, persist-as-data, render-from-data.** The execution plane is the only party that
knows which credential a run used, so it is the only party allowed to say so. The value is
captured in the same expression that makes the choice, shipped over the existing daemon-token
channel as a closed enum, stored as one ordinary message in the thread's existing message
stream, and rendered by a pure mapping. Nothing downstream re-derives it from configuration —
that second source of truth is precisely how the credentials page went stale.

### Affected layers

| Layer | Touched? | What changes |
|---|---|---|
| Execution plane (`@terragon/worker`) | **Yes** | A pure `resolveCredentialSource`, one call at the existing branch, one fail-soft POST. No change to which credential is used. |
| Worker HTTP client (`www-client.ts`) | **Yes** | One new `postRunCredentialSource` function. |
| Control-plane API (`apps/www/src/app/api/daemon/…`) | **Yes** | One new route. |
| Control-plane domain model (`@terragon/shared/model`) | **Yes** | New `credential-source.ts` (tuple + type guard + label map). |
| DB schema (`packages/shared/src/db/schema.ts`) | **No** | **No migration.** The value rides in the existing `messages` jsonb. |
| DB message/UI types (`packages/shared/src/db/*.ts`) | **Yes** | One new `DBMessage` variant, one new `UISystemMessage` variant. |
| Chat UI (`apps/www/src/components/chat`) | **Yes** | `toUIMessages` mapping + one line in `SystemMessage`. |
| Admin credentials page | **No** | Out of scope. Touching it means you left the ticket. |
| In-sandbox daemon (`@terragon/daemon`) | **No** | It does not know `boxTrust`; it posts nothing. |
| `deploy/assert-schema-ready.ts` | **No** | No column added, so nothing to add to `REQUIRED`. |

### Numbered flow

1. A Hatchet agent run starts. `workflow.ts` acquires the box lock and reaps escapees
   (`workflow.ts:496-513`).
2. **The branch (unchanged):** `config.boxTrust === "owner"` → `pullAgentCredentials(...)`;
   anything else → `{ type: "built-in-credits" }` (`workflow.ts:516-518`).
3. `materialiseAgentCredentials(...)` writes the credential into the per-run HOME (or writes
   nothing) and returns `delivered` (`workflow.ts:531-536`).
4. **NEW — the capture, at the branch, in the same block as the existing `step()` log:**
   `const credentialSource = resolveCredentialSource({ boxTrust: config.boxTrust, credentialDelivered: materialised.delivered })`
   → `"user-credential" | "built-in-credits" | "box-key"`. The existing `step()` string is
   rewritten to be *derived from* `credentialSource` so there is exactly one decision, not two.
5. `pullNextMessage(...)`. If it returns `null` (204, nothing to run) the function returns
   `outcome: "nothing-to-run"` and **nothing is posted** (§10 D4).
6. **NEW — the report:** immediately after a message is obtained and
   `resolveUseCredits(...)` has been applied, the worker calls
   `postRunCredentialSource(wwwOpts, { source: credentialSource })` with the value captured in
   step 4. It is awaited (one HTTP round trip) but can never throw and can never fail the run.
7. The route authenticates with `parseDaemonRequest`, applies the generation fence against
   `x-run-external-id`, and calls `updateThreadChat({ updates: { appendMessages: [{ type: "credential-source", source, timestamp }] } })`.
   `updateThreadChat` publishes the realtime broadcast, so an open thread updates live.
8. The thread view reads messages, `toUIMessages` maps the new `DBMessage` to
   `{ role: "system", message_type: "credential-source", parts: [{ type: "text", text: <label> }] }`,
   and `SystemMessage` renders it as one muted line.
9. A run that predates this change has no such message → **nothing renders**. No default, no
   guess (§10 D5).

### File layout

```
packages/shared/src/model/credential-source.ts          NEW   vocabulary + copy (control plane)
packages/shared/src/model/credential-source.test.ts     NEW
packages/shared/src/db/db-message.ts                    MOD   + DBCredentialSourceMessage
packages/shared/src/db/ui-messages.ts                   MOD   + UISystemMessage variant

packages/worker/src/agent-run/types.ts                  MOD   + CREDENTIAL_SOURCES mirror
packages/worker/src/agent-run/types.test.ts             MOD   + mirror drift guard
packages/worker/src/agent-run/workflow.ts               MOD   + resolveCredentialSource, 1 call, 1 post
packages/worker/src/agent-run/workflow.test.ts          MOD   + three-path tests
packages/worker/src/agent-run/www-client.ts             MOD   + postRunCredentialSource   (OWNED BY 209a)
packages/worker/src/agent-run/www-client.test.ts        MOD   + transport tests

apps/www/src/app/api/daemon/run-credential-source/route.ts       NEW
apps/www/src/app/api/daemon/run-credential-source/route.test.ts  NEW
apps/www/src/components/chat/toUIMessages.ts            MOD   + mapping
apps/www/src/components/chat/toUIMessages.test.ts       MOD   + mapping + absent-renders-nothing
apps/www/src/components/chat/chat-message.tsx           MOD   + one-line renderer
```

---

## 6. Archivos a crear o modificar / Files to create or modify

| Ruta (absolute) | Acción | Propósito | Ejemplo del proyecto a seguir |
|---|---|---|---|
| `…/209a/packages/shared/src/model/credential-source.ts` | NUEVO | `CREDENTIAL_SOURCES` tuple, `CredentialSource` type, `isCredentialSource`, `describeCredentialSource` (exhaustive switch → user-facing label) | `packages/shared/src/model/terminal-cause.ts` |
| `…/209a/packages/shared/src/model/credential-source.test.ts` | NUEVO | Every value has a label; an unknown value is rejected; no label contains secret-shaped text | `packages/worker/src/agent-run/types.test.ts` |
| `…/209a/packages/worker/src/agent-run/types.ts` | MODIFICAR | `CREDENTIAL_SOURCES` structural mirror + `describeCredentialSource` worker-side log wording | same file, `TERMINAL_CAUSES` at `:98-135` |
| `…/209a/packages/worker/src/agent-run/types.test.ts` | MODIFICAR | Mirror drift guard (tuple length + unknown throws) | same file, existing `describe` block |
| `…/209a/packages/worker/src/agent-run/workflow.ts` | MODIFICAR | `resolveCredentialSource` (exported pure fn) + one call at the branch + one fail-soft post | `resolveUseCredits` in the same file (`:117-148`) |
| `…/209a/packages/worker/src/agent-run/workflow.test.ts` | MODIFICAR | Three paths → three distinct values; consistency with `resolveUseCredits` | existing `resolveUseCredits` tests in the same file |
| `…/209a/packages/worker/src/agent-run/www-client.ts` | MODIFICAR **(owned by 209a)** | `postRunCredentialSource` — never throws | `postEgressEvents` (`:388-417`) |
| `…/209a/packages/worker/src/agent-run/www-client.test.ts` | MODIFICAR | Body shape, headers, swallow-on-throw, swallow-on-non-2xx, no-secret assertion | existing `postRunFailed` / `postEgressEvents` tests |
| `…/209a/apps/www/src/app/api/daemon/run-credential-source/route.ts` | NUEVO | Auth → zod enum → generation fence → append one message | `apps/www/src/app/api/daemon/run-terminal/route.ts` |
| `…/209a/apps/www/src/app/api/daemon/run-credential-source/route.test.ts` | NUEVO | 401/403/400/409/200, append-only, status unchanged | `apps/www/src/app/api/daemon/run-terminal/route.test.ts` |
| `…/209a/packages/shared/src/db/db-message.ts` | MODIFICAR | `DBCredentialSourceMessage` added to the `DBMessage` union | `DBStopMessage` in the same file |
| `…/209a/packages/shared/src/db/ui-messages.ts` | MODIFICAR | 4th `UISystemMessage` variant | the `"stop"` / `"git-diff"` variants (`:35-44`) |
| `…/209a/apps/www/src/components/chat/toUIMessages.ts` | MODIFICAR | Map the DB message → the UI system message | the `dbMessage.type === "stop"` branch |
| `…/209a/apps/www/src/components/chat/toUIMessages.test.ts` | MODIFICAR | Mapping + "no message ⇒ no UI message" | existing `system-init` cases |
| `…/209a/apps/www/src/components/chat/chat-message.tsx` | MODIFICAR | One muted line; `getLabel`/`getDotClassName` exhaustive switches updated | the `message_type === "stop"` early return (`:333-335`) |

### Per-file detail

#### `packages/shared/src/model/credential-source.ts` (NEW)

```ts
export const CREDENTIAL_SOURCES = [
  "user-credential",
  "built-in-credits",
  "box-key",
] as const;
export type CredentialSource = (typeof CREDENTIAL_SOURCES)[number];

export function isCredentialSource(value: string): value is CredentialSource { … }

/** The ONE place the user-facing copy lives. Exhaustive switch = the drift guard. */
export function describeCredentialSource(source: CredentialSource): string {
  switch (source) {
    case "user-credential":  return "your connected Claude Code credential";
    case "built-in-credits": return "built-in credits";
    case "box-key":          return "this box's own API key";
  }
  // assertNever(source) — mirrors terminal-cause.ts
}
```

Hard rule: this file contains **only** literals and copy. No token, no key, no `process.env`.

#### `packages/worker/src/agent-run/types.ts` (MODIFY)

Append, beside `TERMINAL_CAUSES`, with the same "structural mirror, never imported across the
plane boundary" comment, `CREDENTIAL_SOURCES` / `CredentialSource` and a worker-side
`describeCredentialSource` returning the **log** wording (not the UI copy):
`"delivered user credential (run HOME)"`, `"built-in credits (control-plane proxy)"`,
`"box ANTHROPIC_API_KEY"`.

#### `packages/worker/src/agent-run/workflow.ts` (MODIFY)

Add, next to `resolveUseCredits`:

```ts
/**
 * The ONE place the execution plane names which credential a run actually took.
 * Called exactly once, at the branch that already decides it (below). Never
 * re-derived at read time — a value re-derived from WORKER_BOX_TRUST later would
 * be a second source of truth and would go stale the way the credentials page did.
 */
export function resolveCredentialSource({
  boxTrust,
  credentialDelivered,
}: {
  boxTrust: "owner" | "shared" | "box-key";
  credentialDelivered: boolean;
}): CredentialSource {
  if (credentialDelivered) return "user-credential";
  if (boxTrust === "box-key") return "box-key";
  return "built-in-credits";
}
```

Then, in the block at `workflow.ts:544-556` (the existing `step()` that already names all three
paths), compute `const credentialSource = resolveCredentialSource({ boxTrust: config.boxTrust, credentialDelivered: materialised.delivered });`
and **rewrite the existing `step()` to derive its text from `credentialSource`**, so the log
and the persisted attribution cannot disagree. Hold `credentialSource` in the enclosing scope.

After `message.useCredits = resolved.useCredits;` (`workflow.ts:717`) and before
`daemon.sendMessage(message)`, add:

```ts
await postRunCredentialSource(wwwOpts, { source: credentialSource });
```

> Why there and not at step 4: a run that pulls a 204 "nothing to run" never executes an agent,
> and a credential line on it would be noise in the user's thread. The **value** is still
> decided and frozen at the branch; only the transport happens here. This is a locked decision
> (§10 D4).

Do not change `resolveUseCredits`, the boxTrust gate, or `materialiseAgentCredentials`.

#### `packages/worker/src/agent-run/www-client.ts` (MODIFY — owned by 209a)

```ts
/**
 * POST this run's credential ATTRIBUTION — a closed three-value enum and nothing
 * else (#209 item 1). NEVER a credential, a token, or any fragment of one: the
 * parameter type is the union, so there is no shape in which a secret could be
 * passed. NEVER throws — attribution is reporting, and reporting must not fail a
 * run (the postRunFailed / postEgressEvents contract).
 */
export async function postRunCredentialSource(
  opts: WwwClientOpts,
  { source }: { source: CredentialSource },
): Promise<void> { … }
```

Body: `{ threadId, threadChatId, source }`. Headers: the existing `headers(opts)` (daemon
token + optional `traceparent` + `x-run-external-id`). Catch the throw → `console.error(…)`,
return. Non-2xx → `console.error(…)`, return. Never `redactSecrets` anything here — there is
nothing to redact, and adding it would imply there might be.

#### `apps/www/src/app/api/daemon/run-credential-source/route.ts` (NEW)

Modelled line-for-line on `run-terminal/route.ts`:

```ts
const bodySchema = z.object({
  threadId: z.string().min(1),
  threadChatId: z.string().min(1),
  source: z.enum(CREDENTIAL_SOURCES),
});
```

1. `parseDaemonRequest(request, bodySchema)` → 401 / 403 / 400 handled for us.
2. `checkThreadGeneration({ db, threadId, runExternalId: request.headers.get("x-run-external-id") })`
   → `not-found` ⇒ 404; `superseded` / `stale-generation` ⇒ **409** (log and return, exactly as
   `run-terminal` does); `null` header fails open by design.
3. `updateThreadChat({ db, userId: r.ctx.userId, threadId, threadChatId, organizationId: r.ctx.organizationId, updates: { appendMessages: [{ type: "credential-source", source, timestamp: new Date().toISOString() }] } })`.
4. `console.log("[run-credential-source] recorded", { threadId, source })` — the enum only.
5. `return NextResponse.json({ recorded: true })`.

**Must NOT:** call `updateThreadChatWithTransition`, set `errorMessage`, set `status`, touch
`terminalCause`, or call `handleThreadFinish`. Appending is the whole job.

#### `packages/shared/src/db/db-message.ts` (MODIFY)

```ts
export type DBCredentialSourceMessage = {
  type: "credential-source";
  source: CredentialSource;
  timestamp?: string;
};
```

…added to the `DBMessage` union. No free-text field. Importing `CredentialSource` from
`../model/credential-source` keeps one definition inside the control plane.

#### `packages/shared/src/db/ui-messages.ts` (MODIFY)

```ts
| {
    role: "system";
    message_type: "credential-source";
    parts: UITextPart[];   // exactly one, the resolved label
  }
```

#### `apps/www/src/components/chat/toUIMessages.ts` (MODIFY)

A branch alongside the `"stop"` branch: clear the current agent/user message, then push
`{ role: "system", message_type: "credential-source", parts: [{ type: "text", text: describeCredentialSource(dbMessage.source) }] }`.
If `dbMessage.source` is not a known value (a row written by a future or corrupted writer),
**push nothing** — never render a guess.

#### `apps/www/src/components/chat/chat-message.tsx` (MODIFY)

An early return beside the `"stop"` one:

```tsx
if (message.message_type === "credential-source") {
  return (
    <div className="p-2 text-muted-foreground text-sm">
      Credential: {message.parts[0]?.text}
    </div>
  );
}
```

…plus a `case "credential-source": return "";` in both `getLabel()` and `getDotClassName()`
so the `never` exhaustiveness checks (`chat-message.tsx:305-307`, `:326-328`) still compile.

---

### Implementation phases

Verification for **every** phase is the project's canonical command, run from the worktree
ROOT `/Users/senior/.superset/projects/automata-platform/.claude/worktrees/209a`:

```bash
pnpm turbo tsc-check --force \
  && pnpm --filter @terragon/worker exec vitest run --no-file-parallelism \
  && pnpm --filter @terragon/shared exec vitest run --no-file-parallelism \
  && pnpm --filter @terragon/www exec vitest run --no-file-parallelism
```

It takes several minutes (three suites). Do **not** scope it down, and do **not** run it from
inside a sub-package — that bypasses turbo's cross-package build ordering and has previously
produced false "module not found" failures for correct code. Run it with
`dangerouslyDisableSandbox: true` (§8).

#### Phase 1 — the vocabulary, both planes (4 files)

Preamble (run before touching any file in this phase, not a phase of its own):
`pnpm install --frozen-lockfile --prefer-offline` from the worktree root, and confirm Docker
Desktop is running (the www/shared suites need it).

Touches:
1. `…/209a/packages/shared/src/model/credential-source.ts` (NEW)
2. `…/209a/packages/shared/src/model/credential-source.test.ts` (NEW)
3. `…/209a/packages/worker/src/agent-run/types.ts` (MOD)
4. `…/209a/packages/worker/src/agent-run/types.test.ts` (MOD)

Done when: both tuples have the same three members, both exhaustive switches compile, the
mirror drift guard passes, and the "no label contains secret-shaped text" assertion passes.

#### Phase 2 — the decision and the transport (4 files)

Touches:
1. `…/209a/packages/worker/src/agent-run/workflow.ts` (MOD)
2. `…/209a/packages/worker/src/agent-run/workflow.test.ts` (MOD)
3. `…/209a/packages/worker/src/agent-run/www-client.ts` (MOD)
4. `…/209a/packages/worker/src/agent-run/www-client.test.ts` (MOD)

Done when: `resolveCredentialSource` returns three distinct values for the three inputs; it
agrees with `resolveUseCredits` across the whole input space; `postRunCredentialSource`
swallows both a thrown fetch and a non-2xx; the POST body contains exactly
`{ threadId, threadChatId, source }` and its JSON matches no secret-shaped pattern.

#### Phase 3 — persistence (3 files)

Touches:
1. `…/209a/packages/shared/src/db/db-message.ts` (MOD)
2. `…/209a/apps/www/src/app/api/daemon/run-credential-source/route.ts` (NEW)
3. `…/209a/apps/www/src/app/api/daemon/run-credential-source/route.test.ts` (NEW)

Done when: the route returns 401/403/400/404/409/200 per `api-contract.md`; a 200 appends
exactly one message; the thread's `status`, `errorMessage` and `terminalCause` are **byte-for-byte
unchanged** after the call (asserted against the real Postgres row).

#### Phase 4 — the line in the thread (4 files)

Touches:
1. `…/209a/packages/shared/src/db/ui-messages.ts` (MOD)
2. `…/209a/apps/www/src/components/chat/toUIMessages.ts` (MOD)
3. `…/209a/apps/www/src/components/chat/toUIMessages.test.ts` (MOD)
4. `…/209a/apps/www/src/components/chat/chat-message.tsx` (MOD)

Done when: each of the three sources renders its own line; a message list with no
credential-source message produces no such UI message; an unknown `source` value produces no UI
message.

---

## 7. API Contract

There **is** real API surface: one new control-plane endpoint. See the sibling file
`docs/specs/209a/api-contract.md` for the full method / URL / auth / request / response /
status-code detail.

Summary: `POST /api/daemon/run-credential-source` accepts an `X-Daemon-Token`-authenticated
body of `{ threadId, threadChatId, source }` where `source` is one of exactly three string
literals, applies the #125 C1 generation fence from the `x-run-external-id` header, appends one
message to the thread's existing message stream, and answers `{ recorded: true }`. It is the
only new endpoint. No existing endpoint's contract changes.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/daemon/run-credential-source` | `X-Daemon-Token` (daemon-purpose token, F2-bound to the thread/threadChat) | Record which credential path this run took |

---

## 8. Criterios de éxito / Success criteria

### Verifiable checkboxes

- [ ] `resolveCredentialSource` is called **exactly once** in the worker. `grep -rn "resolveCredentialSource" /Users/senior/.superset/projects/automata-platform/.claude/worktrees/209a/packages/worker/src` shows the definition, one call site in `workflow.ts`, and test references — nothing else.
- [ ] `grep -rn "WORKER_BOX_TRUST\|boxTrust" /Users/senior/.superset/projects/automata-platform/.claude/worktrees/209a/apps/www/src` returns **nothing**. The control plane never learns the box's trust mode; it only receives the already-decided label.
- [ ] `git -C /Users/senior/.superset/projects/automata-platform/.claude/worktrees/209a diff --stat -- packages/shared/src/db/schema.ts deploy/assert-schema-ready.ts` is **empty**.
- [ ] The admin credentials page is untouched: `git -C … diff --name-only` contains no path under `apps/www/src/app/(app)/admin` or any credentials page.
- [ ] No new write path to `WORKER_BOX_TRUST` anywhere: `grep -rn "WORKER_BOX_TRUST" …/209a --include="*.ts" --include="*.tsx"` is unchanged except for `config.ts` and its existing tests.

### Required tests (file + scenario)

| File | Scenario | Maps to |
|---|---|---|
| `packages/worker/src/agent-run/workflow.test.ts` | `resolveCredentialSource({ boxTrust: "owner", credentialDelivered: true })` → `"user-credential"` | DoD "three paths" |
| `packages/worker/src/agent-run/workflow.test.ts` | `{ boxTrust: "shared", credentialDelivered: false }` → `"built-in-credits"` (the #209 defect's exact configuration) | DoD "three paths" |
| `packages/worker/src/agent-run/workflow.test.ts` | `{ boxTrust: "box-key", credentialDelivered: false }` → `"box-key"` | DoD "three paths" |
| `packages/worker/src/agent-run/workflow.test.ts` | The three results are pairwise distinct (`new Set([...]).size === 3`) | DoD "its own distinct attribution" |
| `packages/worker/src/agent-run/workflow.test.ts` | For every `{boxTrust} × {delivered}` pair, `resolveCredentialSource` agrees with `resolveUseCredits`: `delivered ⇒ "user-credential"`; `!delivered && !useCredits ⇒ "box-key"`; `!delivered && useCredits ⇒ "built-in-credits"` | AC "recorded at the point the plane actually decides" |
| `packages/worker/src/agent-run/www-client.test.ts` | POST body is exactly `{threadId, threadChatId, source}` and the URL is `/api/daemon/run-credential-source` | AC "short label" |
| `packages/worker/src/agent-run/www-client.test.ts` | A thrown `fetch` is swallowed (resolves, does not reject) | §10 D6 |
| `packages/worker/src/agent-run/www-client.test.ts` | A 500 is swallowed and logged, not thrown | §10 D6 |
| `packages/worker/src/agent-run/www-client.test.ts` | **No-secret assertion:** the serialized request body, asserted with `expect(JSON.parse(body))).toEqual({threadId, threadChatId, source})` *and* a regex sweep for `sk-`, `sk-ant`, `ghp_`, `ghs_`, `Bearer `, `-----BEGIN`, `"contents"`, `"value"` finding **zero** matches | DoD "asserted rather than assumed" |
| `packages/shared/src/model/credential-source.test.ts` | Every member of `CREDENTIAL_SOURCES` has a non-empty label; `isCredentialSource("anything-else")` is `false` | AC "short label" |
| `packages/shared/src/model/credential-source.test.ts` | No label matches the secret-shaped regex sweep above | DoD "no secret material" |
| `packages/worker/src/agent-run/types.test.ts` | The worker mirror has exactly 3 members and `describeCredentialSource("nope" as CredentialSource)` throws | drift guard |
| `apps/www/src/app/api/daemon/run-credential-source/route.test.ts` | No token → 401; non-daemon token → 403; token bound to another thread → 403 | §14 |
| `apps/www/src/app/api/daemon/run-credential-source/route.test.ts` | `source: "anything-else"` → **400**, and **no message is appended** | §13 |
| `apps/www/src/app/api/daemon/run-credential-source/route.test.ts` | Valid call → 200 `{recorded:true}`, exactly one message appended, `status`/`errorMessage`/`terminalCause` **unchanged** in the DB row | §5 step 7 |
| `apps/www/src/app/api/daemon/run-credential-source/route.test.ts` | `x-run-external-id` naming a stale generation → **409**, nothing appended | #125 C1 |
| `apps/www/src/app/api/daemon/run-credential-source/route.test.ts` | Absent `x-run-external-id` → fails open, 200 | `decideThreadGeneration` |
| `apps/www/src/components/chat/toUIMessages.test.ts` | Each of the three DB messages produces its own distinct UI line | AC "legible from the UI alone" |
| `apps/www/src/components/chat/toUIMessages.test.ts` | **A message list with no credential-source message produces no credential-source UI message** — no default, no guess | DoD "renders nothing" |
| `apps/www/src/components/chat/toUIMessages.test.ts` | `{ type: "credential-source", source: "future-value" }` produces **no** UI message | AC "never render a confident wrong answer" |

### Exact verification command

From `/Users/senior/.superset/projects/automata-platform/.claude/worktrees/209a`:

```bash
pnpm turbo tsc-check --force \
  && pnpm --filter @terragon/worker exec vitest run --no-file-parallelism \
  && pnpm --filter @terragon/shared exec vitest run --no-file-parallelism \
  && pnpm --filter @terragon/www exec vitest run --no-file-parallelism
```

**Environment notes (these are the sandbox, never your change):**
- The worker suite binds local ports → `listen EPERM` under the Bash sandbox.
- The www and shared suites start a throwaway Postgres via docker compose → `permission denied … docker.sock` under the Bash sandbox.
- Re-run the **whole** command with `dangerouslyDisableSandbox: true`. Budget several minutes.
- `--force` on `tsc-check` is mandatory: the turbo cache replays other worktrees' results and a cached pass is **not** evidence.

---

## 9. Criterios de UX / UX criteria

- **Loading:** none. The line is part of the message stream and arrives with it (and live, via
  the `updateThreadChat` broadcast). There is no spinner, no skeleton, no separate fetch.
- **Formularios:** Not applicable — this feature has no form and no input. It is strictly
  read-only in the user's direction (§10 D1).
- **Passwords:** Not applicable — no password, no credential and no fragment of one is ever
  rendered (§14).
- **Errores:** a failed attribution POST is invisible to the user by design: the run proceeds
  and the thread simply has no credential line. The user never sees an error about
  attribution, because attribution failing is not the user's problem — the run is.
- **Navegación:** none. No new route, no new page, no link.
- **Accesibilidad:** the line is ordinary text in the transcript's reading order, using the
  existing `text-muted-foreground` token (contrast already approved elsewhere in the
  transcript). No icon-only meaning, no colour-only meaning: unlike the sibling system
  messages, this one carries **no status dot** — the information is entirely in the words. No
  `aria-live` (it is not an alert).

---

## 10. Decisiones tomadas / Decisions made (LOCKED — the implementer must not change these)

**D1 — Nothing here is user-writable.** No endpoint, form, setting, mutation or feature flag in
this change can write `WORKER_BOX_TRUST` or the credential source. #209 is explicit: box trust
is a property of a **box**, not of a user; one shared box serves everyone; it is the security
boundary that decides whether a box pulls a user's delivered credential onto its disk. This
ticket **reports**. Why: a user-writable "use my credential" switch on a shared box is a
privilege escalation, not a feature.

**D2 — Storage route (a): the existing `messages` jsonb. No migration.** The attribution is a
new `DBMessage` variant stored in `thread.messages` / `thread_chat.messages`, which already
exist. Route (b) — a new column — was **rejected** because this repo's production schema
migration is manual (no drizzle push in CI; the prod `DATABASE_URL` is a write-only Cloudflare
Worker secret), so a column would impose a two-step ordered manual deploy *and* an entry in
`deploy/assert-schema-ready.ts` `REQUIRED`, for a value that the message stream already carries
natively and renders natively. **Consequence: no manual prod schema push is required before
this deploy.** State this in the PR (DoD).
*If this decision is ever reversed*, the column goes in `packages/shared/src/db/schema.ts`
**and** `deploy/assert-schema-ready.ts` `REQUIRED` in the SAME change, and the PR must say
loudly that a manual prod push must precede the deploy.

**D3 — A new narrow route, not `/api/daemon-event`.** Reusing `/api/daemon-event` would flip
the thread `booting → working` (`machine.ts:92`) before the agent produced anything, and would
null `errorMessage`/`errorMessageInfo` (`handle-daemon-event.ts:352-353`). Reporting must not
move the state machine.

**D4 — The value is captured at the branch; the POST happens once a message exists.**
`resolveCredentialSource` is evaluated in the same block as the existing `step()` log at
`workflow.ts:544-556`, and that `step()` is rewritten to derive from it so there is one
decision, not two. The POST is sent after `pullNextMessage` returns a message, so a
`nothing-to-run` 204 leaves no credential line in a user's thread. The value is frozen at the
branch and never recomputed.

**D5 — Absent means silent.** A run with no recorded attribution renders **nothing**: no
default, no "unknown" chip, no inference from configuration. An absent attribution must never
become a confident wrong answer. The same applies to an unrecognised `source` value.

**D6 — Attribution is fail-soft, once.** `postRunCredentialSource` never throws, is never
retried, and never fails or delays a run beyond its single round trip. Worst case: the line is
missing. That is strictly better than today, where it is always missing.

**D7 — Exactly three labels.** `user-credential`, `built-in-credits`, `box-key`. A credential
pull that failed under `boxTrust=owner` reports `built-in-credits`, because that is what the
run actually used. Distinguishing "you have no credential" from "we could not fetch yours" is
a different ticket (§"Open questions").

**D8 — Cross-plane vocabulary is mirrored, not imported.** `@terragon/worker` must not gain a
dependency on `@terragon/shared`. Follow the `TERMINAL_CAUSES` precedent exactly: two tuples,
two exhaustive switches, a drift-guard test on the worker side.

**D9 — The copy lives in exactly one place per plane.** `describeCredentialSource` in
`packages/shared/src/model/credential-source.ts` is the only source of the user-facing strings.
No string literal for these labels anywhere in `apps/www/src/components`.

---

## 11. Edge cases

- **Datos inválidos (`source` not in the enum):** `z.enum(CREDENTIAL_SOURCES)` → **400**,
  nothing appended, nothing logged beyond the zod failure. A malformed or truncated JSON body →
  400 from `parseDaemonRequest`.
- **API errors, per status code:**
  - **400** — bad body / unknown `source`. Worker logs and continues; the run is unaffected.
  - **401** — missing or invalid `X-Daemon-Token` (e.g. the token was already revoked). Worker
    logs and continues.
  - **403** — a non-daemon token, or a daemon token bound to a different thread/threadChat (F2).
    Worker logs and continues.
  - **404** — the thread row is gone (`checkThreadGeneration` → `not-found`). Worker logs and
    continues.
  - **409** — a newer generation owns the thread (#125 C1). **Correct behaviour, not an error:**
    a superseded run must not write into the live run's transcript. Worker logs and continues.
  - **5xx** — control-plane failure. Worker logs and continues; no retry (D6).
- **Sin conexión (fetch throws, DNS/TLS/tunnel down):** caught, logged, run continues. This is
  the `postRunFailed` contract (`www-client.ts:245-252`) and is tested.
- **Timeout:** the POST inherits the platform `fetch` default; no custom timeout is added, and
  none is needed — a hang here would be bounded by Hatchet's step timeout exactly as every other
  www call in this file is. **Do not add a speculative `AbortSignal.timeout`**; no observed
  failure motivates it (simplicity rule).
- **Respuesta vacía / inesperada:** the worker never parses the response body. Only
  `res.ok` is consulted. A `204`, an empty body or an HTML error page all behave identically:
  logged if not ok, otherwise ignored.
- **Doble submit:** the worker posts once per run, in a straight-line code path with no retry.
  If a duplicate ever occurred (a Hatchet step retry replaying the whole task), the thread would
  show the line twice — cosmetic, never wrong, never a secret. **Do not add a de-duplication
  mechanism**; there is no mechanism in this code path that can produce one today, and a guard
  for an impossible state is the speculation this spec forbids.
- **Legacy (v0) threads** where `threadChatId === LEGACY_THREAD_CHAT_ID`: handled transparently
  by `updateThreadChat`, which writes `schema.thread.messages` instead of
  `schema.threadChat.messages` (`threads.ts:938-985`). No special case in the route.
- **In-sandbox (non-remote-plane) runs:** post nothing, render nothing. Expected.

---

## 12. Estados de UI requeridos / Required UI states

| State | Behaviour |
|---|---|
| **idle** | The line sits in the transcript at its chronological position. No interactivity. |
| **loading** | Not applicable — the line arrives with the message stream; there is no separate fetch and no skeleton. |
| **success** | One muted line: `Credential: your connected Claude Code credential` / `Credential: built-in credits` / `Credential: this box's own API key`. |
| **error** | Not applicable — the renderer is a pure mapping over data already in hand; it has no request to fail. A failed *write* manifests as **empty**, below. |
| **empty** | No credential-source message in the thread (a pre-change run, an in-sandbox run, a run whose POST failed) ⇒ **nothing is rendered**. No placeholder, no "unknown". Locked by D5. |
| **disabled** | Not applicable — there is no control. |
| **offline** | The transcript is whatever the client last loaded; no new fetch, no degraded state of its own. |

---

## 13. Validaciones / Validations

### Validaciones de cliente

Not applicable — this feature has **no form and no user input**. There is no field a user can
type into, so there is no client-side rule and no client-side message.

| Campo | Regla | Mensaje |
|---|---|---|
| — | No hay entrada de usuario en esta fase (#209 item 1 es solo de lectura) | — |

### Validaciones de servidor

Defer to `docs/specs/209a/api-contract.md`. In short: `threadId` and `threadChatId` are
non-empty strings; `source` must be one of exactly three literals (`z.enum(CREDENTIAL_SOURCES)`),
which is the structural guarantee that no free text — and therefore no secret — can enter the
persisted value. Anything else is a 400 with nothing written.

---

## 14. Seguridad y permisos / Security & permissions

- **No secret is ever persisted or rendered.** The wire type is the three-literal union; the
  stored field is the same union; the rendered string comes from a hardcoded label map. There
  is no shape in which a credential could travel this path. This is enforced at the boundary by
  `z.enum`, not by convention, and asserted by the no-secret test sweep (§8).
- **This repo has already shipped a token leak through a persisted failure string** (the
  `execFile` argv leak into a persisted reason). The lesson applied here: the only defence that
  holds is one where the leaking shape is **unrepresentable**, not one where it is filtered.
  Note the contrast with `postRunFailed`, which must call `redactSecrets` (`www-client.ts:241`)
  precisely because it carries free text. Our payload carries none — so **do not** add
  `redactSecrets` here; doing so would signal that free text is expected.
- **Auth:** `parseDaemonRequest` → 401 (no/invalid token), 403 (non-daemon token), 403 (F2
  binding: the token is bound to one `threadChatId` and one `threadId`; a daemon token for
  thread A can never write thread B).
- **Generation fence:** 409 for a superseded or stale generation — a cancelled run cannot write
  into the live run's transcript. `runExternalId: null` fails open, matching every other fenced
  route.
- **No privilege is created.** Nothing in this change lets any caller — user, API client, or
  worker — alter `WORKER_BOX_TRUST`, alter which credential a run uses, or read a credential.
  The control plane is never told the box's trust mode, only the already-decided outcome.
- **401/403 flow:** the worker logs and continues; the run's outcome is unchanged. There is no
  user-facing 401/403 surface in this feature.
- **Logging:** `handleDaemonEvent` logs inbound message arrays verbatim (`:77-88`). Our route
  does not use that handler, and its own log line prints only `{ threadId, source }`.

---

## 15. Observabilidad y logging

The project's real mechanisms, and nothing new:

- **Worker side:** `console.warn` / `console.error` with a `[agent-run]` prefix
  (`www-client.ts:171`, `:246`, `:265`), and Hatchet's `ctx.log` through the `step()` helper
  (`workflow.ts:546`). Log the enum; the existing `step()` already names the credential mode
  and is rewritten to derive from `credentialSource` so log and data agree.
- **Control plane:** `console.log("[run-credential-source] recorded", { threadId, source })`,
  mirroring `run-terminal/route.ts:114-120`.
- **Never log:** the credential file contents, the `env-var` value, the daemon token, the run
  bearer, the prompt, or any portion of any of them. (`pullAgentCredentials`' own docblock,
  `www-client.ts:96-100`, states this for the object it returns; nothing in this change touches
  that object.)
- **No new metric, no new PostHog event, no new table.** The attribution is already queryable
  from the thread's message stream, which is the surface the ticket asked for.

---

## 16. i18n / textos visibles

**Not applicable — this repo has no i18n framework.** `grep -rn "next-intl\|useTranslations"`
over `apps/www/src` returns nothing, and the sibling system-message labels are hardcoded English
`switch` arms (`chat-message.tsx:287-308`). Introducing translation keys for one line would be
unrequested scope.

The equivalent discipline is applied instead: **every visible string lives in exactly one
place**, `describeCredentialSource` in `packages/shared/src/model/credential-source.ts`
(§10 D9). No label literal may appear in a component.

| "Key" (switch arm) | Visible text |
|---|---|
| `user-credential` | `your connected Claude Code credential` |
| `built-in-credits` | `built-in credits` |
| `box-key` | `this box's own API key` |
| (renderer prefix, `chat-message.tsx`) | `Credential: ` |

---

## 17. Performance

- **Renders:** one extra element in a transcript that already renders hundreds. `toUIMessages`
  gains one `else if` arm — O(1) per message, no change to its single pass.
- **Repeated API calls:** exactly **one** POST per run, in a straight-line path, never retried
  (D6). No polling, no interval, no client-side fetch at all.
- **Debouncing / cancellation:** not applicable — there is no user-triggered call to debounce.
  The POST does not take an `AbortSignal`: it is a sub-second fire-and-forget that must complete
  even as the run winds down, and it cannot block teardown because it cannot throw.
- **Caching:** none, and none needed — the value is a field of data the thread view already
  fetches. No new query, no new index, no new round trip on read.
- **DB cost:** one `UPDATE … SET messages = messages || $1::jsonb` per run, on a row the run
  already touches many times. No new index; the write is keyed on the existing primary key.

---

## 18. Restricciones / Restrictions (hard "do not" rules)

1. **Do not** edit the admin credentials page, or anything under it. That is #209 item 2.
2. **Do not** add per-box trust control. That is #209 item 3, gated on #193.
3. **Do not** add any control — UI, API, flag, setting — that writes `WORKER_BOX_TRUST` or the
   credential source.
4. **Do not** add a column to `packages/shared/src/db/schema.ts`. If you believe you must, stop
   and report it as a blocker — it changes the deploy into a two-step manual migration and
   requires a `deploy/assert-schema-ready.ts` `REQUIRED` entry in the same change.
5. **Do not** persist or render a credential, a token, or any fragment of one. The payload type
   is a closed union; keep it that way. No `string` field, no "detail", no "reason".
6. **Do not** change `resolveUseCredits`, the `boxTrust` gate at `workflow.ts:516-518`, or
   `materialiseAgentCredentials`. This ticket reports; it does not re-route.
7. **Do not** re-derive the credential source anywhere downstream from `WORKER_BOX_TRUST` or
   from the user's stored credential. One decision, recorded once.
8. **Do not** route the attribution through `/api/daemon-event` — it moves the status machine.
9. **Do not** let the attribution POST throw, retry, or block the run.
10. **Do not** render a default when the attribution is absent or unrecognised.
11. **Do not** add a worker dependency on `@terragon/shared`. Mirror the tuple.
12. **Do not** scope the verification command down, and do not run it from inside a sub-package
    directory.
13. **Do not** "improve" adjacent code, comments or formatting. Only the files named in §6.
14. **Do not** touch any file owned by another ticket. `packages/worker/src/agent-run/www-client.ts`
    is owned by **this** ticket (209a); everything else in §6 is unowned and must stay minimal.

---

## 19. Entregables / Deliverables

- [ ] `packages/shared/src/model/credential-source.ts` + its test.
- [ ] `CREDENTIAL_SOURCES` mirror + drift guard in `packages/worker/src/agent-run/types.ts` / `types.test.ts`.
- [ ] `resolveCredentialSource` in `workflow.ts`, called exactly once, with the existing `step()` rewritten to derive from it.
- [ ] `postRunCredentialSource` in `www-client.ts` (never throws) + tests.
- [ ] `POST /api/daemon/run-credential-source` + route tests (401/403/400/404/409/200, append-only, status unchanged).
- [ ] `DBCredentialSourceMessage` + `UISystemMessage` variant + `toUIMessages` mapping + tests.
- [ ] One-line renderer in `chat-message.tsx`.
- [ ] `docs/specs/209a/spec.md` (this file) and `docs/specs/209a/api-contract.md`.
- [ ] **PR description states which storage route was taken and why the other was rejected:**
      "Existing `messages` jsonb (route a). A new column was rejected because prod schema
      migration here is manual and a column would force an ordered two-step deploy plus an
      `assert-schema-ready` `REQUIRED` entry, for a value the message stream already carries and
      renders natively. **No manual prod schema push is required for this deploy.**"
- [ ] PR also notes: no existing endpoint's contract changed; one new endpoint added.

---

## 20. Checklist final para el agente / Final agent checklist

- [ ] Every path I typed is absolute and rooted at `/Users/senior/.superset/projects/automata-platform/.claude/worktrees/209a`.
- [ ] I touched only the files listed in §6. `git -C …/209a status --short` shows nothing else.
- [ ] `git -C …/209a diff -- packages/shared/src/db/schema.ts deploy/assert-schema-ready.ts` is empty.
- [ ] No file under the admin credentials page appears in the diff.
- [ ] `grep -rn "WORKER_BOX_TRUST\|boxTrust" …/209a/apps/www/src` returns nothing.
- [ ] `resolveCredentialSource` has exactly one non-test call site.
- [ ] The persisted and wire types are closed unions — no `string` field anywhere on this path.
- [ ] The no-secret test sweep exists and passes (asserted, not assumed).
- [ ] A thread with no credential-source message renders nothing — there is a test proving it.
- [ ] An unrecognised `source` renders nothing — there is a test proving it.
- [ ] The full canonical command passed from the worktree ROOT, with `--force`, with
      `dangerouslyDisableSandbox: true`, all four stages green:
      `pnpm turbo tsc-check --force && pnpm --filter @terragon/worker exec vitest run --no-file-parallelism && pnpm --filter @terragon/shared exec vitest run --no-file-parallelism && pnpm --filter @terragon/www exec vitest run --no-file-parallelism`
- [ ] I read the actual exit code; I did not read a piped/grepped summary.
- [ ] The PR body names the storage route and says no manual prod schema push is needed.
- [ ] Anything surprising I decided silently is instead reported as a blocker (below).

---

## Open questions / blockers to raise rather than guess past

1. **Copy wording.** `"your connected Claude Code credential"` is proposed, not quoted from
   existing product copy — this repo has no prior string for this concept (the nearest neighbours
   are the worker log strings at `workflow.ts:546-555` and the `describeTerminalCause` chip copy
   at `packages/shared/src/model/terminal-cause.ts:30+`). The *agent* is not always Claude —
   `pullAgentCredentials` returns an `agent` field and Codex/Gemini/Amp exist. If the wording
   should name the actual agent, that is a product decision. **Default if nobody answers:** the
   agent-neutral `"your connected credential"`. Raise before shipping.
2. **A credential pull that failed is reported as `built-in-credits`** (§0 row 7, §10 D7) — true
   to what the run used, but it does hide "we had a credential and could not fetch it". The DoD
   names three paths, so three it is. Flag for a follow-up ticket; do not add a fourth label
   here.
3. **Where the line should sit in the transcript.** Posting after `pullNextMessage` (D4) places
   it after the user's prompt message. If product wants it pinned above the run instead, that is
   a UI decision requiring a different surface (a header chip), which requires a thread column,
   which requires a migration — i.e. it would flip D2. Raise before implementing anything other
   than D4.
4. **Review-lane threads.** The attribution POST uses the same daemon token the review lane
   already holds; nothing here needs a GitHub token. Confirmed by reading the route's auth path,
   but not exercised end-to-end against a live review run in this worktree. If a live review run
   is available before merge, verify the line appears on one.
