# Agent bus S1: the run ledger and lane capabilities (who may spawn and message whom)

Part of #651 (agent bus: a run starts, messages, waits on and reads child runs through its own MCP tools), which is part of #650 (epic: a project's weekly KPI reports run by Automata from one Automation). This is slice 1 of 5; S2–S5 build on it, and #648 (multi-repo fan-out, one read-only repo per child run) depends on S1 + S3.

## Why

#651 needs every bus call to answer "who is calling, and may they do this?" before anything is sent or spawned. On 2026-11-16 the owner decided (decision record on #651):

- **Identity (G3):** the caller is the run whose **daemon token** (`X-Daemon-Token`) made the call. Lane, parent and grants are read from the database on every call, never from token claims. There is no separate launch token.
- **A run (G2):** a run is a thread. The bus keeps its own row per run in a new `agent_run` ledger keyed by `thread_id`; bus state is derived from the thread's status plus a ledger-held `blocked` flag that only the control plane sets.
- **Lanes (G7):** a lane is a *name for a capability set* `{spawn, sendTo, repoGrant, skills, maxDepth}`, persisted per run. A child's set is the parent's intersected with what it asks for; anything wider is refused at mint, and every call re-checks against the ledger. Only `task` and `review` ship; `control` is added when something launches it. This is independent of the display-only `RunDisplayLane`.
- **Repo grant (G4):** until #648, a root run's grant is its thread's repo with write access; a child may only ask for a repo in its parent's grant and gets it read-only.

Precedents behind G7: Kubernetes RBAC ("cannot grant what you do not hold"), AWS IAM effective permissions as an intersection, GitHub reusable-workflow permissions "maintained or reduced", Claude Code subagent tool allowlists with a depth cap of 3; AgentDojo measured least-privilege tool scoping cutting targeted attack success from 57.7% to 6.8% (arXiv 2406.13352). Authority from an inferred label is CWE-807.

## Reality check (main @ 2b8409e1)

| What | Where | Status |
|---|---|---|
| Per-run daemon token context `{userId, organizationId, threadId, threadChatId}` | `apps/www/src/lib/daemon-token-context.ts:13-37`; `getDaemonTokenContext` in `apps/www/src/lib/auth-server.ts` | exists (used by S5, not here) |
| `thread.githubRepoFullName` (notNull), `thread.parentThreadId`, `thread.organizationId` (nullable) | `packages/shared/src/db/schema.ts:372,383,387,454` | exists |
| Terminal thread statuses | `TERMINAL_THREAD_STATUSES`, `packages/shared/src/model/thread-effective-status.ts:55`; `ThreadStatus` in `packages/shared/src/db/types.ts:279-309` (no `blocked`) | exists |
| Display-only lane | `packages/utils/src/run-lane.ts:1-33` (`review \| pr \| task \| self-heal-*`, enforces nothing) | exists; **not** reused for authority |
| Ledger-style model with DB tests | `packages/shared/src/model/cell-authority.ts` + `.test.ts` (#597) | pattern to follow |
| `agent_run` table, lane capabilities, bus policy | grep `agent_run`, `AgentBusLane` in apps/, packages/, deploy/ | **none** |
| Latest migration | `deploy/migrations/2026-11-17-execution-profile-seed-opensandbox-runc.sql` | new file sorts after it |

## Scope

1. **Schema + migration.** `agent_run` in `packages/shared/src/db/schema.ts` and `deploy/migrations/2026-11-17-agent-run.sql` (`-- migrate:expand`, `IF NOT EXISTS`):
   - `thread_id text primary key references thread(id) on delete cascade`
   - `organization_id text not null references organization(id) on delete cascade`
   - `parent_thread_id text references thread(id) on delete set null` (null = root)
   - `lane text not null` (`task` | `review`)
   - `capabilities jsonb not null` (the compiled set below)
   - `depth integer not null default 0`
   - `outlive_parent boolean not null default false`, `deadline timestamptz` (written by S3)
   - `blocked_at timestamptz`, `blocked_reason text` (set only by the control plane)
   - `created_at timestamptz not null default now()`
   - index on `parent_thread_id`.
2. **Pure policy module** `packages/shared/src/model/agent-bus/capabilities.ts` (no DB):
   - `type AgentBusLane = "task" | "review"`.
   - `interface AgentCapabilities { spawn: AgentBusLane[]; sendTo: AgentBusLane[]; repoGrant: { repo: string; access: "read" | "write" }[]; skills: string[] | null /* null = unrestricted */; maxDepth: number }`.
   - `capabilitiesForLane(lane, { repoGrant, skills })`: `task` → spawn `[task, review]`, sendTo `[task, review]`; `review` → spawn `[]`, sendTo `[]`. `maxDepth` 3.
   - `narrowForChild(parent, request: { lane, repo?, skills? })` → `{ ok: true, capabilities, depth }` or `{ ok: false, error }`: lane must be in `parent.spawn` (else `lane_pair_not_allowed:<parent>-><child>`); repo (default: the parent's first grant) must be in `parent.repoGrant` (else `repo_not_granted`), child gets `[{repo, access: "read"}]`; skills must be ⊆ parent's (null parent allows any; else `skill_not_granted`); `depth = parentDepth + 1 ≤ maxDepth` (else `depth_exceeded`); child `spawn`/`sendTo` = lane's ∩ parent's.
   - `authorizeSend(from, to)` → `ok` | `not_found` | `lane_pair_not_allowed:<from>-><to>` | `target_not_running` | `agent_blocked`, in that order: absent or other org → `not_found`; pair not in `from.sendTo` **and** `to` is not `from`'s parent → `lane_pair_not_allowed`; `to` terminal → `target_not_running`; `to` blocked → `agent_blocked`.
   - `busStateOf(threadStatus, blockedAt)` → `starting | running | blocked | done | failed | cancelled` (terminal set from `TERMINAL_THREAD_STATUSES`).
3. **Model** `packages/shared/src/model/agent-bus/agent-run.ts` (DB injected):
   - `ensureRootRun(db, { threadId, organizationId, lane })`: insert-if-absent a root row from the thread (`repoGrant = [{repo: thread.githubRepoFullName, access: "write"}]`, `skills = null`, depth 0); returns the row. A thread with no `organizationId` → `null` (the bus is org-only).
   - `createChildRun(db, { parentThreadId, childThreadId, organizationId, request })`: re-reads the parent row, runs `narrowForChild`, inserts the child row; returns the refusal unchanged when narrowing fails. (S3 calls it after creating the thread.)
   - `getRunForOrg(db, { organizationId, threadId })`: the row joined with its thread's status, or `null` both when absent and when another org's — **one code path, one return value** (not-found parity).
   - `markBlocked` / `clearBlocked(db, { threadId, reason })`.

## Out of scope

The message tables and delivery (S2), spawning threads and cancellation (S3), artifacts (S4), the MCP route, token check and UI (S5), `control` lane, #648's `targetRepos`, subtree budgets.

## Acceptance criteria

1. The migration applies on a fresh database and on one with the baseline; `deploy/schema-drift.ts` reports no drift between migrations and `schema.ts`; `node deploy/lint-migrations.ts` passes.
2. `narrowForChild` refuses: a `review` parent spawning anything (`lane_pair_not_allowed:review->task`, `…review->review`); a repo outside the parent's grant (`repo_not_granted`); a skill outside the parent's set (`skill_not_granted`); depth above `maxDepth` (`depth_exceeded`). A permitted child is never wider than its parent on any field (property test over random parent/request pairs).
3. `authorizeSend` returns the documented error for each case in the documented order; a `review` run may send to its parent and to nobody else.
4. `getRunForOrg` returns the identical value (`null`, deep-equal) for an absent thread id and for another org's thread id.
5. `ensureRootRun` is idempotent (two calls, one row) and returns `null` for a thread without an org.
6. `busStateOf` maps every `ThreadStatus` value (exhaustive switch; the type check fails if one is added) and `blocked_at` wins over a running status.

## Tests

- Unit (`packages/shared`, vitest): `capabilities.test.ts` for AC2, AC3, AC6.
- DB (`packages/shared` vitest with the throwaway Postgres): `agent-run.test.ts` for AC4, AC5 and the child-insert path, using `createTestOrg`/`createTestThread` from `model/test-helpers`.
- Gates: `pnpm turbo tsc-check`, `pnpm turbo lint`, `pnpm turbo format-check`, `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism`, coverage via `vitest run --coverage` on `@terragon/shared`.

## UAT

- T0: the tests above.
- T1/T2: none; S1 has no runtime caller until S3/S5.

## Risks / rollback

- Expand-only migration; nothing reads the table yet. Rollback = revert the PR; the empty table may stay (a later contract migration drops it if abandoned).
- The migration must reach prod before any revision that reads it (repo rule); S1 alone ships no reader.

## Definition of done

AC 1–6 met with evidence in the PR; gates green; the `agent_run` migration merged; #651's checklist ticks S1.

## References

#651 (decision record comment), #650, #648, #597 (cell-authority ledger pattern), #601 (opaque-token helper), `packages/utils/src/run-lane.ts`.


---

# Ground truth for the implementer (verified in this worktree, branch feat/659-agent-run-ledger @ 2b8409e1, 2026-11-17)

## Verified to exist

| Fact | Where |
|---|---|
| `thread` table; `organizationId` nullable (`:383`), `githubRepoFullName` notNull (`:387`), `parentThreadId` FK (`:454`), its index (`:512`) | `packages/shared/src/db/schema.ts:372-520` |
| Ledger-style table + model + DB test to copy the shape of (FK to `organization` and `thread` with `onDelete: "cascade"`) | `cellStep` `packages/shared/src/db/schema.ts:3309`; `packages/shared/src/model/cell-authority.ts`; `packages/shared/src/model/cell-authority.test.ts` (uses `createDb(env.DATABASE_URL!)`, `createTestOrg`, `createTestThread`, `createTestUser` from `./test-helpers`) |
| Test helpers | `createTestThread({db, userId, overrides?, chatOverrides?})` → `{threadId, threadChatId}` (`packages/shared/src/model/test-helpers.ts:126`); `createTestOrg({db, name?})` → org id (`:295`) |
| Terminal statuses + effective-status SQL | `TERMINAL_THREAD_STATUSES = ["complete","stopped","error","working-stopped"]`, `threadIsTerminal()`, `threadEffectiveStatusSql()` (newest threadChat status, else thread status) in `packages/shared/src/model/thread-effective-status.ts:55-80` |
| `ThreadStatus` union (incl. deprecated `ThreadStatusDeprecated`) | `packages/shared/src/db/types.ts:~260-309` |
| Migration registry: **every new migration id must be appended** | `EXPECTED_MIGRATION_IDS` in `packages/migrate/src/expected-migrations.ts` (last: `2026-11-17-execution-profile-seed-opensandbox-runc`); tests in `packages/migrate/src/*.test.ts` derive counts from it |
| Migration header/lint conventions | `deploy/migrations/2026-11-15-cell-step-allowed-ref.sql` (`-- migrate:expand` + comment), `deploy/lint-migrations.ts`; out-of-order apply only warns (`packages/migrate/src/runner.ts:307`) |
| Display-only lane (do NOT import or extend) | `packages/utils/src/run-lane.ts` |
| `fast-check` | **not** in any workspace package.json — do not add it |

## Verified NOT to exist (build them)

- `agent_run` table, `agentRun` drizzle export, `deploy/migrations/2026-11-17-agent-run.sql`.
- `packages/shared/src/model/agent-bus/` (directory absent).
- `AgentBusLane`, `AgentCapabilities`, `narrowForChild`, `authorizeSend`, `busStateOf`, `ensureRootRun`, `createChildRun`, `getRunForOrg`.

## Implementation notes fixed by the decisions (#651 decision record)

- Identity is the daemon token; this slice does not read tokens. Functions take ids.
- `busStateOf(status: ThreadStatus, blockedAt: Date | null)`: `blockedAt` non-null and status not terminal → `blocked`; `draft|scheduled|queued*|booting` → `starting`; `working|stopping|working-error|working-done|checkpointing` → `running`; `complete` → `done`; `error` → `failed`; `stopped|working-stopped` → `cancelled`; deprecated statuses mapped explicitly. Exhaustive `switch` with a `never` check.
- `getRunForOrg` reads the effective status via `threadEffectiveStatusSql()` and filters by `organization_id` in the same query, so absent and foreign ids share one path and return `null`.
- `ensureRootRun` uses `insert … on conflict (thread_id) do nothing` then select.
- Capabilities stored as `jsonb` typed with drizzle `.$type<AgentCapabilities>()`.
- Root lane is passed by the caller (S5 maps it); S1 does not infer it.
- Property test (AC2): a seeded deterministic loop over generated parent/request pairs (no new dependency).

## Gates (run from the worktree root)

- `pnpm turbo tsc-check`, `pnpm turbo lint`, `pnpm turbo format-check`
- `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism`
- `pnpm --filter @terragon/migrate exec vitest run`
- coverage: `pnpm --filter @terragon/shared exec vitest run --coverage --no-file-parallelism src/model/agent-bus`
- `node deploy/lint-migrations.ts`

---

# Amendment 1 (validate cycle 1, 2026-11-17) — supersedes the Scope text above where they differ

Owner decisions taken in this cycle: **send scope = own tree only**; **coverage = add `@vitest/coverage-v8` as a devDependency of `@terragon/shared`** (version matching vitest 3.x).

## A1. Exact schema (drizzle ⇄ migration must be catalog-identical)

Drizzle (`packages/shared/src/db/schema.ts`, after `cellStep`):

```ts
export const agentRun = pgTable(
  "agent_run",
  {
    threadId: text("thread_id").primaryKey().references(() => thread.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    parentThreadId: text("parent_thread_id").references(() => thread.id, { onDelete: "set null" }),
    /** The root of this run's tree (= threadId for a root). Sends stay inside one tree. */
    rootThreadId: text("root_thread_id").notNull().references(() => thread.id, { onDelete: "cascade" }),
    lane: text("lane").$type<AgentBusLane>().notNull(),
    capabilities: jsonb("capabilities").$type<AgentCapabilities>().notNull(),
    depth: integer("depth").notNull().default(0),
    outliveParent: boolean("outlive_parent").notNull().default(false),
    deadline: timestamp("deadline", { mode: "date" }),
    blockedAt: timestamp("blocked_at", { mode: "date" }),
    blockedReason: text("blocked_reason"),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("agent_run_parent_thread_id_index").on(table.parentThreadId),
    index("agent_run_root_thread_id_index").on(table.rootThreadId),
  ],
);
```

Timestamps are `timestamp` without time zone, like `cell_step` (`schema.ts:3338-3342`). `AgentBusLane`/`AgentCapabilities` are type-only imports from `../model/agent-bus/capabilities` (check that schema.ts already imports from model/ elsewhere; if that would create a cycle, define the two types in `packages/shared/src/db/types.ts` and re-export them from capabilities.ts).

Migration `deploy/migrations/2026-11-17-agent-run.sql` follows `2026-11-13-cell-broker-authority.sql:1-35`: `-- migrate:expand` header + comment; `CREATE TABLE IF NOT EXISTS "agent_run" (...)` with plain columns (`"capabilities" jsonb NOT NULL`, `"depth" integer DEFAULT 0 NOT NULL`, `"outlive_parent" boolean DEFAULT false NOT NULL`, `"created_at" timestamp DEFAULT now() NOT NULL`); each FK in its own `DO $$ BEGIN ALTER TABLE "agent_run" ADD CONSTRAINT "<name>" FOREIGN KEY (...) REFERENCES "public"."<t>"("id") ON DELETE <cascade|set null> ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;` with the drizzle names `agent_run_thread_id_thread_id_fk`, `agent_run_organization_id_organization_id_fk`, `agent_run_parent_thread_id_thread_id_fk`, `agent_run_root_thread_id_thread_id_fk`; `CREATE INDEX IF NOT EXISTS "agent_run_parent_thread_id_index" ON "agent_run" USING btree ("parent_thread_id");` and the same for `root_thread_id`. Append `"2026-11-17-agent-run"` to `EXPECTED_MIGRATION_IDS`.

## A2. Typed signatures

```ts
export type AgentBusLane = "task" | "review";
export interface AgentRepoGrant { repo: string; access: "read" | "write" }
export interface AgentCapabilities {
  spawn: AgentBusLane[]; sendTo: AgentBusLane[];
  repoGrant: AgentRepoGrant[]; skills: string[] | null; maxDepth: number;
}
export interface AgentRunView {          // what getRunForOrg returns
  threadId: string; organizationId: string; parentThreadId: string | null; rootThreadId: string;
  lane: AgentBusLane; capabilities: AgentCapabilities; depth: number;
  status: ThreadStatus;                  // effective status
  terminal: boolean;                     // threadIsTerminal(): terminal cause OR terminal status
  blockedAt: Date | null;
}
narrowForChild(parent: { lane: AgentBusLane; capabilities: AgentCapabilities; depth: number },
               request: { lane: AgentBusLane; repo?: string; skills?: string[] })
  : { ok: true; capabilities: AgentCapabilities; depth: number } | { ok: false; error: AgentBusError };
authorizeSend(from: AgentRunView, to: AgentRunView | null): "ok" | AgentBusError;
```

## A3. Rules the property test checks (narrowForChild)

- `lane ∉ parent.capabilities.spawn` → `lane_pair_not_allowed:<parent.lane>-><request.lane>`.
- Repo: default = `parent.capabilities.repoGrant[0].repo`; no grant → `repo_not_granted`. Matching is **case-insensitive** (GitHub full names); the child stores the parent grant's spelling. Child grant = `[{repo, access: "read"}]`.
- Skills: request omitted → child inherits the parent's value exactly. Request given → every entry must be in the parent's list (`skill_not_granted`), any list allowed when the parent is `null`. A non-null parent never yields a `null` child.
- `maxDepth` child = `min(laneDefault 3, parent.maxDepth)`. `depth = parent.depth + 1`; refuse with `depth_exceeded` when `depth > maxDepth` (roots are depth 0, so at most 4 levels 0..3 — intended, mirrors Claude Code's nesting cap).
- `spawn`/`sendTo` child = lane default ∩ parent's.
- Property: for every generated (parent, request) pair that returns ok, the child is a subset of the parent on spawn, sendTo, repoGrant (repo set, and access never read→write), skills, and maxDepth.

## A4. authorizeSend, in order

1. `to === null` or `to.organizationId !== from.organizationId` or **`to.rootThreadId !== from.rootThreadId`** → `not_found` (other trees are invisible; byte-identical to absent).
2. `from.terminal` → `sender_not_running`; `from.blockedAt` → `agent_blocked` (a blocked run neither sends nor receives).
3. `to.lane ∉ from.capabilities.sendTo` and `to.threadId !== from.parentThreadId` → `lane_pair_not_allowed:<from.lane>-><to.lane>`.
4. `to.terminal` → `target_not_running`.
5. `to.blockedAt` → `agent_blocked`.

`AgentBusError` is the union of these strings plus `repo_not_granted | skill_not_granted | depth_exceeded`.

## A5. busStateOf

Includes the deprecated `queued-blocked` → `starting` (`ThreadStatusDeprecated` = `queued-blocked | error | stopped | working-stopped`, `types.ts:273-277`). `terminal` comes from `threadIsTerminal()` in `getRunForOrg`; `busStateOf(status, blockedAt, terminal)` returns the terminal mapping when `terminal` is true even if the status is not terminal (terminal cause → `failed` unless status says `complete`/`stopped`).

## A6. Model semantics

- `ensureRootRun(db, { threadId, organizationId, lane })`: reads the thread; returns `null` when it is absent, its `organizationId` is null, or it differs from the argument. Insert `{rootThreadId: threadId, parentThreadId: null, depth: 0, repoGrant: [{repo: thread.githubRepoFullName, access: "write"}], skills: null}` `on conflict (thread_id) do nothing`; returns the existing row **unchanged** on conflict (even if its lane differs or it is a child).
- `createChildRun(db, { organizationId, parentThreadId, childThreadId, request })`: parent row and child thread both read scoped to `organizationId` (otherwise `not_found`); the child thread's `parentThreadId` must equal `parentThreadId` (otherwise `not_found`); parent must not be terminal (`sender_not_running`); then `narrowForChild`; insert with `rootThreadId = parent.rootThreadId`.
- `getRunForOrg(db, { organizationId, threadId })`: one query joining `agent_run` and `thread` with `organization_id = $org`, selecting `threadEffectiveStatusSql()` and `threadIsTerminal()`; `null` otherwise.

## A7. Gates (replace the Gates list above)

- `pnpm install --frozen-lockfile --prefer-offline` (after adding `@vitest/coverage-v8` the lockfile is updated with `pnpm --filter @terragon/shared add -D @vitest/coverage-v8@<vitest major.minor>`)
- `pnpm turbo tsc-check`, `pnpm turbo lint`, `pnpm turbo format-check`
- `node deploy/lint-migrations.ts`
- `pnpm --filter @terragon/migrate exec vitest run`
- `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism`
- coverage: `pnpm --filter @terragon/shared exec vitest run --coverage --coverage.include='src/model/agent-bus/**' --no-file-parallelism src/model/agent-bus`
- AC1 schema drift, local: Postgres 18 in docker on a spare port; `createdb a`, `createdb b`; `DATABASE_URL=$PG/a pnpm exec tsx deploy/migrate.ts --apply` twice (second prints 0 applied); `DATABASE_URL=$PG/b pnpm -C packages/shared exec drizzle-kit push --force`; `pnpm exec tsx deploy/schema-drift.ts --a $PG/a --b $PG/b` exits 0 (mirrors `.github/workflows/ci.yml:161-210`).

## A8. Added acceptance criterion

7. A run cannot message a run in another tree of the same org: `authorizeSend` returns `not_found`, deep-equal to an absent id.

---

# Amendment 2 (validate cycle 1 result, 2026-11-17)

- **createChildRun order:** org-scoped reads → child thread's `parentThreadId` matches (else `not_found`) → parent terminal → `sender_not_running` → **parent `blockedAt` → `agent_blocked`** → `narrowForChild` → insert `on conflict (thread_id) do nothing`; when a row already exists for the child thread, return the typed refusal `run_exists` (never overwrite, never return another run's row as success). DB tests cover the blocked-parent and duplicate-child cases.
- **Rootness** is `rootThreadId === threadId` (equivalently `depth === 0`), never `parentThreadId === null` (a deleted mid-tree parent nulls it via `set null`).
- **AC3 tests** assert the two `agent_blocked` cases separately, and that a blocked sender to a terminal target gets `agent_blocked` (step 2 before step 4).
- **Coverage dependency:** `pnpm --filter @terragon/shared add -D @vitest/coverage-v8@3.2.7` (vitest resolves to 3.2.7 through the lockfile override, `pnpm-lock.yaml:152`).
- Migration columns copy cell_step's spelling: `"thread_id" text PRIMARY KEY NOT NULL`, `"root_thread_id" text NOT NULL`; FK actions `ON DELETE cascade|set null ON UPDATE no action`; `drift-allowlist.json` stays unchanged.
- `AgentBusError` adds `run_exists`.
- **Phases** (validator's plan): P1 capabilities.ts + test + coverage dependency (package.json, pnpm-lock.yaml); P2 schema.ts + migration + EXPECTED_MIGRATION_IDS; P3 agent-run.ts + test.

---

# Amendment 3 (roborev rounds 1-2, owner-approved, 2026-11-17)

- The migration is `deploy/migrations/2026-11-18-agent-run.sql` (id `2026-11-18-agent-run`, appended last in `EXPECTED_MIGRATION_IDS`), so it sorts after `2026-11-17-execution-profile-seed-opensandbox-runc`, already on main.
- `createChildRun` runs in one transaction that locks the parent's `agent_run` row `FOR UPDATE` (serializes with `markBlocked`); a parent ending in that window is covered by the G6 reconciler.
- `createChildRun` binds the grant to the child thread's own repo: `repo` defaults to the child thread's `githubRepoFullName`; a requested repo that differs from it (case-insensitively) is `repo_not_granted`; the repo must also be in the parent's grant (`narrowForChild`).
- (round 3) A root's access follows its lane: `task` → `write`, `review` → `read` (owner decision; refines G4). `getRunForOrg` validates the stored `lane` as well as `capabilities`; either malformed throws.
- (round 4) `ensureRootRun` returns `null` for a thread whose parent thread has an `agent_run` row (a bus child joins only through `createChildRun`); a fork whose parent is not on the bus can still be a root.
- (round 5, owner-approved) `root_thread_id` has **no foreign key** (indexed column only): deleting a root's thread keeps its descendants' narrowed rows; `ensureRootRun` on a former child returns that row. New index `agent_run_organization_id_index`. `ensureRootRun` runs in one transaction: its own thread row `FOR NO KEY UPDATE`, the parent thread row `FOR SHARE` before checking the parent's ledger row (child-before-parent lock order).
