# #728: view and edit a repo's egress settings (API, UI, docs)

Ticket: https://github.com/be-automata/automata/issues/728 (parent #634). Local copy:
`.git/somnio-dev-execution/728/ticket.md`.
Branch `feat/728-egress-settings`, worktree base `origin/main` @ `b84dbd69` (2026-11-20).
The CLI slice waits for #617 (OD-6) and is not built here.

Bindings read for this spec: `automata-cli-practices` (hard rules 1-10, command design rules,
conformance matrix), `DESIGN.md`, `AGENTS.md` (migrations, release notes), the repo `CLAUDE.md`
verification commands.

---

## 1. Acceptance criteria (verbatim) and decisions

### Decisions (2026-11-20, owner took the recommendations)

| #    | Decision                                                                                                                                                                          |
| :--- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OD-1 | `ip_port` is hidden in the UI, and shown read-only when it is already stored.                                                                                                     |
| OD-2 | The new API refuses entries a cell can't use, with a named code (`wildcard_not_allowed`, `port_not_allowed`). The legacy PUT is unchanged.                                        |
| OD-3 | A new append-only `repo_egress_audit_log` (expand migration), following the `knowledge_admin_log` / `self_heal_admin_log` pattern, written in the same transaction as the change. |
| OD-4 | A new org-scoped **Settings → Egress** page with a register of repos.                                                                                                             |
| OD-5 | The legacy PUT accepts an optional `organizationId` and refuses a mismatch now. It becomes required for egress fields after one release.                                          |
| OD-6 | The CLI part waits for #617. The API, UI and docs ship first.                                                                                                                     |
| OD-7 | Today's rule: an org admin, or a GitHub admin of that repo, may edit.                                                                                                             |
| OD-8 | `{org}` accepts the org id or its slug.                                                                                                                                           |

### Acceptance criteria

`[CLI]` marks a part deferred to the CLI slice on #617 (OD-6). An AC with only a `[CLI]` part
left is closed by this ticket's PRs for its non-CLI parts and re-opened on the CLI ticket.

1. `GET /api/v1/orgs/{org}/repos/{owner}/{repo}/egress` with a valid CLI key for `{org}` returns 200, `x-api-version: 1`, and `stored`, `box`, `cell`, `warnings`. For a repo with no row it returns `stored.level: null`, `box.enforced: false` and the platform-only `cell`. — **PR-3**
2. A `PATCH` with a valid key for org A edits org A's row for that repo. **Org B's row for the same `owner/repo` is byte-identical before and after** (asserted in the database). — **PR-3**
3. A valid key minted for org B, calling `{org}=A`, gets `403 org_mismatch`, and no row changes. A personal key with no org gets `403 org_required`. A daemon token gets `401`. — **PR-3**
4. A session whose **active org is B**, editing through the UI or REST with `{org}=A`, writes org A's row only, or is refused with `403 org_forbidden` when the user is not a member of A. The active org is never used. The motivating bug becomes a test that fails on today's code. — REST: **PR-3**; UI: **PR-4**
5. A non-admin (neither an org admin nor a GitHub admin of the repo) gets `403 not_repo_admin`. The UI shows the panel read-only with that reason. The CLI exits 1 with `error.code: "not_repo_admin"`. — API **PR-3**; UI **PR-4**; `[CLI]` exit 1
6. **Negative control.** Each of `*.example.com`, `example.com:8443`, `10.0.0.1`, `::1`, `exa mple`, `*.co.uk`, and 101 hosts is refused, with its own code (`wildcard_not_allowed`, `port_not_allowed`, `ip_not_allowed`, `ipv6_not_allowed`, `invalid_host`, `public_suffix_wildcard`, `too_many_entries`), `entry` and `index`:
   - by the API with 400; — **PR-2** (classifier) + **PR-3** (wire)
   - by the UI inline before Save, with the same words; — **PR-4**
   - by the CLI locally with exit 2 and **zero HTTP requests**. — `[CLI]`
7. `add` and `remove` are atomic. Two concurrent `add`s of different hosts both land. A stale `expectedUpdatedAt` on a full replace gets `409 conflict` with `currentUpdatedAt`. — **PR-3**
8. Adding `storage.googleapis.com` or an S3 host returns a `multi_tenant_upload_host` warning, and the UI shows it before Save. Switching to `domain` needs a confirm that names the box effect, in the UI and with `--yes` in a non-TTY CLI. — warning **PR-2/PR-3**; UI **PR-4**; `[CLI]` `--yes`
9. Every accepted change writes exactly one audit row in the same transaction, with the actor, the token or session, the org, the repo, the before and after level, the hosts added and removed, and the registries flag before and after. `egress.history` returns it. A refused write leaves no row. PostHog still carries no hosts. — table **PR-2**; writes + history **PR-3**
10. The contract declares every error the handlers throw: UNAUTHORIZED, FORBIDDEN (with `org_mismatch`/`org_forbidden`/`org_required`/`not_repo_admin`), NOT_FOUND, BAD_REQUEST (with entry codes), CONFLICT and SERVICE_UNAVAILABLE. The UI, the CLI and the docs examples all call these same procedures. — **PR-3** (contract), **PR-4** (UI calls), **PR-5** (docs); `[CLI]` CLI calls
11. The CLI meets conformance-matrix cases 1-9, 13, 14, 18, 19 and 20 for every `egress` subcommand. `--dry-run` causes zero database writes, asserted by the row count. — `[CLI]` entirely. PR-3 ships the server half `dryRun` (see §4.2) so the CLI needs no local copy of the effective computation.
12. `apps/docs/content/docs/api/egress.mdx` exists and is linked from the security and CLI pages. It covers the token, the explicit org, each endpoint with `curl`, the schema, the version header, every error code, the level semantics on box and cell, and the #719 warning. `fumadocs-mdx` builds. — **PR-5**
13. The legacy PUT with a body `organizationId` that differs from the active org gets `409 active_org_changed` and writes nothing. — **PR-1**
14. No client org or repo name appears in code, fixtures, docs or tests. Use `acme/*`-style placeholders. — every PR

---

## 2. Ground truth, re-verified 2026-11-20 at `b84dbd69`

Legend: **holds** = the ticket's claim is true at the cited place; **drift** = true but the lines
moved; **does not hold** = the claim is wrong or incomplete, with what is true instead.

### 2.1 API and storage

| #   | Claim                                                                                                                                                | Where                                                                                                                                   | Quote                                                                                                                                                   | Verdict                                                                           |
| :-- | :--------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------- |
| G1  | Three egress columns on `repo_review_settings`                                                                                                       | `packages/shared/src/db/schema.ts:1567,1607,1614,1621`                                                                                  | `egressPolicy: text("egress_policy")` · `egressAllowlist: text("egress_allowlist").array()` · `cellEgressRegistries: boolean("cell_egress_registries")` | holds                                                                             |
| G2  | Per-repo route exports only PUT and DELETE                                                                                                           | `apps/www/src/app/api/review-settings/[owner]/[repo]/route.ts:90,297`                                                                   | `export async function PUT(` / `export async function DELETE(`                                                                                          | holds                                                                             |
| G3  | The only read is the active-org list, `[]` without an org                                                                                            | `apps/www/src/app/api/review-settings/route.ts:15-31`; DTO `review-settings-route-shared.ts:42-56`                                      | `// No active org → nothing to scope to. Return an empty set, not an error.`                                                                            | holds                                                                             |
| G4  | Session cookie only, org = active org while a membership backs it, no body org                                                                       | `route.ts:94-103`; `apps/www/src/lib/auth-server.ts:78-97,105-114`                                                                      | `const organizationId = session.session.activeOrganizationId;` … `membership: membership ? { organizationId, role: membership.role } : null`            | holds                                                                             |
| G5  | Write permission = org admin or GitHub repo admin, fail-closed, free-text 403                                                                        | `route.ts:60-88`; `apps/www/src/lib/repo-admin.ts:31-57`                                                                                | `"Only organization admins or admins of this repository can change its review settings."`                                                               | holds                                                                             |
| G6  | Type checks on the three fields                                                                                                                      | `review-settings-route-shared.ts:277-333`                                                                                               | `egressPolicy must be null or one of …` / `egressAllowlist must be null or an array of strings` / `cellEgressRegistries must be null or a boolean`      | holds                                                                             |
| G7  | Value check pairs the partial patch with the stored half; refusal is `400 {error}` with no code                                                      | `review-settings-route-shared.ts:344-365`; model fence `packages/shared/src/model/repo-review-settings.ts:379-391`                      | `return NextResponse.json({ error }, { status: 400 });`                                                                                                 | holds (model fence drift: 379-391, not 374-390)                                   |
| G8  | Allowlist replaces the whole list; CAS via `expectedUpdatedAt`, `null` = first write; 409 `{error:"conflict", currentUpdatedAt}`                     | `route.ts:198-226,256-272`; `repo-review-settings.ts:295-494`                                                                           | `setWhere = expectedUpdatedAt ? eqAtMillisecond(…) : expectRowAbsent ? sql\`false\` : …`                                                                | holds                                                                             |
| G9  | PostHog `review_tolerance_set` carries level, registries flag, changed keys, no hosts                                                                | `route.ts:274-292` (comment at 284)                                                                                                     | `// The level only: allowlist entries may name internal hosts.`                                                                                         | holds                                                                             |
| G10 | Only DB actor log on the route is self-heal; precedent `knowledge_admin_log`                                                                         | `review-settings-route-shared.ts:236-260`; `schema.ts:2771-2793` (`self_heal_admin_log`), `schema.ts:3081-3103` (`knowledge_admin_log`) | `/** Append-only log of knowledge org control changes. */` · `/** No FK on purpose: the log survives user deletion. */ actorUserId`                     | holds                                                                             |
| G11 | **Not in the ticket:** the legacy `DELETE` removes the whole row (egress included) in the active org with no org check and no audit row              | `route.ts:297-365`                                                                                                                      | `const { removed, conflict } = await removeRepoReviewSetting({ db, organizationId: ctx.organizationId, …`                                               | new fact: the drift bug applies to DELETE too (see §4.7)                          |
| G12 | **Not in the ticket:** today nothing decides whether a repo "belongs" to an org. The PUT creates a row for any `owner/repo` string in the active org | `route.ts:168-179` (no repo lookup before the upsert)                                                                                   | `const repoFullName = repoFromParams(owner, repo);`                                                                                                     | new fact: AC-1's "no row → 200" and the "not_found" case need a definition (§4.4) |

### 2.2 Egress rules

| #    | Claim                                                                                                                                                                | Where                                                                                                                                                                             | Quote                                                                                                                          | Verdict                                                                                                                                                       |
| :--- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G13  | Levels, `DOMAIN_RE` (≥ 2 labels), domain entries `host`/`*.host`/`host:port` (1-65535), ip_port = IPv4[:port]                                                        | `packages/shared/src/model/egress-policy.ts:26,36-37,64-86`                                                                                                                       | `const bare = host.startsWith("*.") ? host.slice(2) : host;`                                                                   | holds                                                                                                                                                         |
| G14  | The box: no row/no policy = no enforcement, `none` = system hosts only, else operator + system                                                                       | `egress-policy.ts:121-145`; `apps/www/src/server-lib/egress/resolve-egress-policy.ts:78-113`                                                                                      | `if (level === "none") { return { level, allowlist: canonicalizeEntries(systemHosts) }; }`                                     | holds                                                                                                                                                         |
| G15  | `egressPolicyFromRow` lives in **apps/www** and takes a `plane`                                                                                                      | `resolve-egress-policy.ts:103-114`, system hosts `:40-64`                                                                                                                         | `export function egressPolicyFromRow(row, plane: EgressPlane)`; worker plane = `[callbackHost, "api.anthropic.com"]`           | **does not hold for Step 2**: a `packages/shared` `effectiveEgress` cannot call it (shared does not depend on www). The composition goes in apps/www (§4.5)   |
| G16  | `effectiveEgressFields` already exists in shared                                                                                                                     | `egress-policy.ts:158-175`                                                                                                                                                        | `export function effectiveEgressFields(patch, stored)`                                                                         | name clash with the ticket's `effectiveEgress`; this spec names the view `getRepoEgressView`                                                                  |
| G17  | The box validator is first-throw and private                                                                                                                         | `egress-policy.ts:64` (`function assertValidEntry`, not exported), `:93` (`function canonicalizeEntries`, not exported), `:184-193` (`findEgressPolicyError` returns one message) | `throw new Error(\`Invalid egress allowlist entry …\`)`                                                                        | **does not hold as "map, don't re-parse" without a change**: per-entry results need `assertValidEntry` and `canonicalizeEntries` exported (moved, not copied) |
| G18  | Cell compile: no policy → platform (+registries); `none` → platform, opt-in ignored; `domain` → per-run bundle (+registries); `ip_port` → `egress_level_unsupported` | `packages/shared/src/model/cell-egress-catalog.ts:124-158`                                                                                                                        | `if (shape?.level === "ip_port") { return { ok: false, code: "egress_level_unsupported" }; }`                                  | holds                                                                                                                                                         |
| G19  | Cell refuses wildcard, non-443 port, IP literal, IPv6, public-suffix wildcard, > 100 entries                                                                         | `cell-egress-catalog.ts:172-197`; `packages/shared/src/model/cell-egress.ts:57,59-73,118-201,307-320`                                                                             | `reason: "egress_wildcard"` · `"port_not_443"` · `"ip_literal"` · `"ipv6"` · `"public_suffix_wildcard"` · `"too_many_entries"` | holds, with three nuances below                                                                                                                               |
| G19a | The per-entry normalizer is private and lives in a file that imports `node:crypto` and `psl`                                                                         | `cell-egress.ts:2,9,118` (`function normalizeEntry`)                                                                                                                              | `import { createHash } from "node:crypto";`                                                                                    | it must be exported to classify per entry, and it **cannot be bundled into a client component** (§4.3, §5)                                                    |
| G19b | Some refusals deliberately **do not echo** the entry (credential safety)                                                                                             | `cell-egress.ts:122-127,135-138,148-153,182-187`                                                                                                                                  | `"invalid_host: entry is not a bare ASCII host (URL, credentials or non-punycode name); not echoed"`                           | AC-6's `entry` is `null` for these (`exa mple` is one); `index` is always set                                                                                 |
| G19c | The cap counts the **rendered** set, platform hosts included                                                                                                         | `cell-egress.ts:298-320`; platform bundle `:87-92` (2 hosts)                                                                                                                      | `names.length > CELL_EGRESS_MAX_ENTRIES` over `renderedNames(set.entries)`                                                     | a repo's own budget is **98** hosts, **81** with registries (17). "101 hosts" is refused, but so is 99. The UI counter shows the real budget                  |
| G20  | **Gap:** the write validator accepts `*.host` and `host:8443` that keep a repo off cells                                                                             | `egress-policy.ts:79-85` vs `cell-egress-catalog.ts:189-195`                                                                                                                      | —                                                                                                                              | holds                                                                                                                                                         |
| G21  | `registries@1` = 17 exact hosts, storage hosts left out                                                                                                              | `cell-egress-catalog.ts:27-63`                                                                                                                                                    | `// Multi-tenant storage hosts (storage.googleapis.com, S3) are left out on purpose.`                                          | holds (counted: 17)                                                                                                                                           |
| G22  | The cell's broker host comes from the public app URL                                                                                                                 | `apps/www/src/server-lib/compute/cell-gate.ts:112-114`; callers `cell-eligibility.ts:83-93`, `api/daemon/cell-plan/route.ts:188-195`                                              | `return normalizeCellBrokerHost(new URL(nonLocalhostPublicAppUrl()).hostname);`                                                | holds; the view reuses `cellBrokerHost()`                                                                                                                     |

### 2.3 Token auth and the CLI

| #    | Claim                                                                                                                                      | Where                                                                                                                                                                                                             | Quote                                                                                                                                 | Verdict                                                                                                                                                                        |
| :--- | :----------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G23  | Better Auth API keys via `X-Daemon-Token` → `getDaemonTokenContext` → `{userId, apiKeyId, organizationId, …, tokenType}`                   | `auth-server.ts:221-240`; `apps/www/src/lib/daemon-token-context.ts:55-141`                                                                                                                                       | `const token = request.headers.get("X-Daemon-Token");`                                                                                | holds                                                                                                                                                                          |
| G23a | `Authorization: Bearer` is **not** read anywhere on this path                                                                              | `auth-server.ts:225`                                                                                                                                                                                              | (only `X-Daemon-Token`)                                                                                                               | **does not hold** for "X-Daemon-Token (or Authorization: Bearer)": PR-3 adds a header adapter that feeds a Bearer key to the same `getDaemonTokenContext` (no second verifier) |
| G24  | A CLI key's org is stamped at mint from the active org                                                                                     | `apps/www/src/server-actions/cli-api-token.ts:13-21`; mint UI `apps/www/src/components/cli/main.tsx`                                                                                                              | `...(tenant?.organizationId ? { metadata: { organizationId: tenant.organizationId } } : {})`                                          | holds. **Not in the ticket:** the key keeps its org after the user leaves that org (30-day expiry, `:17`). PR-3 also checks live membership on the token path                  |
| G25  | `/api/cli` = oRPC `RPCHandler`; middleware takes org from the token, refuses daemon tokens, 503 on auth-store failure                      | `apps/www/src/app/api/cli/[[...slug]]/route.ts:1-42`; `apps/www/src/server/orpc/cli-router.ts:22-62`                                                                                                              | `if (tenant.tokenType === "daemon") { throw errors.UNAUTHORIZED(); }` · `throw new ORPCError("SERVICE_UNAVAILABLE", { status: 503, …` | holds. Note the CORS `Access-Control-Allow-Origin: *` at `route.ts:7-15`: not to be copied to a session-authenticated mount                                                    |
| G26  | Contract = `threads.{list,detail,create}` + `auth.whoami`; declared errors UNAUTHORIZED, NOT_FOUND, INTERNAL_ERROR, RATE_LIMIT_EXCEEDED    | `packages/cli-api-contract/src/index.ts:5-18,85-95`                                                                                                                                                               | `const oc = ocBase.errors({ UNAUTHORIZED: …, NOT_FOUND: …, INTERNAL_ERROR: …, RATE_LIMIT_EXCEEDED: … })`                              | holds. SERVICE_UNAVAILABLE is thrown by the shared middleware for **every** procedure yet undeclared (rule 6)                                                                  |
| G26a | No procedure carries `.route()` metadata                                                                                                   | `packages/cli-api-contract/src/index.ts` (whole file)                                                                                                                                                             | —                                                                                                                                     | holds; OpenAPI needs `.route({ method, path })` on the egress procedures                                                                                                       |
| G26b | `cli-api-contract` has no `tsc-check` script                                                                                               | `packages/cli-api-contract/package.json:7-9`                                                                                                                                                                      | `"check": "tsc --noEmit"`                                                                                                             | **not in the ticket**: `pnpm turbo tsc-check` skips it; it is type-checked only through its importers. Run `pnpm --filter @terragon/cli-api-contract check` as an extra gate   |
| G27  | `@orpc/openapi` not installed; `@orpc/server`/`@orpc/contract` 1.14.13                                                                     | `apps/www/package.json:34`; `packages/cli-api-contract/package.json:11`; `apps/cli/package.json:24-25` (`@orpc/client ^1.14.13`, `@orpc/contract 1.14.13`); lockfile `pnpm-lock.yaml:15212-15251` (all `1.14.13`) | `"@orpc/server": "1.14.13"`                                                                                                           | holds                                                                                                                                                                          |
| G28  | "Rate limit through the existing CLI limiter"                                                                                              | `apps/www/src/lib/rate-limit.ts:127-148`                                                                                                                                                                          | `export const cliTaskCreationRateLimit = new Ratelimit({`                                                                             | **does not hold**: the only CLI limiter is for task creation. PR-3 adds `cliEgressWriteRateLimit` next to it (same Upstash pattern)                                            |
| G29  | CLI is `@terragon-labs/cli` (bin `terry`), commands auth/pull/create/list/mcp, build-time URL, config without mode, MCP uses `which terry` | `apps/cli/package.json:2-6`; `apps/cli/src/index.tsx:43,56,113,165,178`; `apps/cli/src/utils/apiClient.ts:10-15`; `apps/cli/src/utils/config.ts:41-45`; `apps/cli/src/mcp-server/index.ts:12-21`                  | `url: \`${process.env.TERRAGON_WEB_URL}/api/cli\``·`spawnSync("which", ["terry"], …)`                                                 | holds (deferred to #617)                                                                                                                                                       |
| G30  | `/api/v1` is free; `/api/v3` is the cells' GitHub shim                                                                                     | `apps/www/src/app/api/v3/[[...path]]/route.ts:7-10`                                                                                                                                                               | `/api/v3/<path>: read-only GitHub REST for a remote cell's \`gh\``                                                                    | holds; no collision                                                                                                                                                            |

### 2.4 Org and repo resolution (needed by §4.4)

| #   | Fact                                                                                                                 | Where                                                                                                                                                           | Quote                                                                                                                     |
| :-- | :------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------ |
| G31 | Org slug is unique; membership by id and by slug exist; the slug read cannot tell "unknown slug" from "not a member" | `schema.ts:130-133`; `packages/shared/src/model/organizations.ts:139-185`                                                                                       | `undefined when the slug is unknown OR the user is not a member, so a caller cannot tell the two apart`                   |
| G32 | Org admin = `owner`/`admin` role                                                                                     | `apps/www/src/lib/org-role.ts:27-41`; `apps/www/src/lib/org-admin-roles.ts:7`                                                                                   | `export const ORG_ADMIN_ROLES = new Set(["owner", "admin"]);`                                                             |
| G33 | A repo's org is resolved from its installation, overridden by `github_repo_org_binding`                              | `packages/shared/src/github-app.ts:440-456` (`getRepoInstallationId`); `packages/shared/src/model/github-installation.ts:202-220,286-300` (`getRepoOrgAndMode`) | `"GET /repos/{owner}/{repo}/installation"`                                                                                |
| G34 | The org-switch guard copy already exists                                                                             | `auth-server.ts:131-133`                                                                                                                                        | `ACTIVE_ORGANIZATION_CHANGED_MESSAGE = "Your active organization changed in another tab. Reload the page and try again."` |

### 2.5 Settings UI, e2e and docs

| #   | Claim                                                                                                                                       | Where                                                                                                                                           | Verdict                                                                            |
| :-- | :------------------------------------------------------------------------------------------------------------------------------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------- |
| G35 | Nav General, GitHub & PRs, Agent, PR Review, Knowledge, Integrations, Billing, Sandbox (flagged), scoped account/organization; no egress UI | `apps/www/src/components/settings/settings-layout.tsx:42-94`; `git grep egressAllowlist apps/www/src/components apps/www/src/queries` → nothing | holds                                                                              |
| G36 | Per-repo settings in PR Review: filterable `RepoRow` register in `SettingsSection`, orphan rows kept                                        | `apps/www/src/components/settings/tab/review.tsx:52,70-111,250-356`; `components/settings/review-tolerance/repo-row.tsx`                        | drift (lines moved: 52 / 70-111 / 250-356)                                         |
| G37 | Repo list scoped to the active org                                                                                                          | `apps/www/src/server-actions/user-repos.ts:24-31`; `apps/www/src/queries/user-repo-queries.ts:10-31` (browser reads `/api/github/repos`)        | holds                                                                              |
| G38 | ScopeBadge and Segmented exist                                                                                                              | `apps/www/src/components/ui/scope-badge.tsx`; `apps/www/src/components/ui/segmented.tsx`; DESIGN.md:146,171-175,188                             | holds                                                                              |
| G39 | e2e specs with a second-org world; outbound GitHub answered from fixtures, any other host fails                                             | `apps/www/e2e/specs/environment-second-org.e2e.ts:1-4` (`WORLD.orgs.{alpha,beta}`, `pool`); `.github/workflows/ci.yml:255-256`                  | holds. PR-4 must add the `GET /repos/{o}/{r}/installation` fixture (§4.4 calls it) |
| G40 | Docs: CLI page and security page, no egress/API page; nav is an explicit list                                                               | `apps/docs/content/docs/integrations/cli.mdx`; `security-permissions.mdx`; `apps/docs/content/docs/meta.json` (explicit `pages`)                | holds; PR-5 adds `api/egress` to `meta.json`                                       |
| G41 | Release notes version constant                                                                                                              | `apps/www/src/lib/constants.ts:2`                                                                                                               | `export const RELEASE_NOTES_VERSION = 18;`                                         |

### 2.6 Migrations

| #   | Fact                                                                                                                                                                         | Where                                                                                                                                                                                    |
| :-- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G42 | The last migration on main is **future-dated** `2026-11-23-repo-cell-egress-registries`; the runner warns and applies out of order when a file sorts before the last applied | `deploy/migrations/` listing; `packages/migrate/src/expected-migrations.ts:37`; `packages/migrate/src/runner.ts:307-310` (`sorts before the already-applied … applying it out of order`) |
| G43 | New ids are appended to `EXPECTED_MIGRATION_IDS`; tests derive counts from it                                                                                                | `packages/migrate/src/expected-migrations.ts:1-38`; `packages/migrate/src/cli.test.ts:98`                                                                                                |
| G44 | Lint rules L1-L6 (IF NOT EXISTS, FK in a `DO … duplicate_object` block, index without CONCURRENTLY allowed on a table created in the same file)                              | `deploy/lint-migrations.ts:13-27`                                                                                                                                                        |
| G45 | Schema drift CI: migrations DB vs `drizzle-kit push` DB on Postgres 18                                                                                                       | `.github/workflows/ci.yml:165-214`                                                                                                                                                       |

### 2.7 `@orpc/openapi` (checked on the npm registry, nothing installed)

- **`@orpc/openapi@1.14.13`** exists (published 2026-07-29, older than two weeks; `latest` is 1.16.4).
  Its dependencies pin the same line: `@orpc/server`, `@orpc/contract`, `@orpc/client`,
  `@orpc/shared`, `@orpc/interop`, `@orpc/standard-server`, `@orpc/openapi-client` all `1.14.13`,
  plus `rou3 ^0.7.12`, `json-schema-typed ^8.0.2`. Exports include `./fetch` (`OpenAPIHandler`)
  and the root (`OpenAPIGenerator`). It matches the repo's `@orpc/server` exactly, so pnpm dedupes
  every `@orpc/*` package.
- The OpenAPI **document** from zod v4 schemas also needs **`@orpc/zod@1.14.13`** and its
  `./zod4` entry (`ZodToJsonSchemaConverter`). Peers: `zod >=3.25.0` (repo has 4.6.7),
  `@orpc/server 1.14.13`, `@orpc/contract 1.14.13`. Deps: `@orpc/json-schema 1.14.13`,
  `wildcard-match`, `escape-string-regexp`.
- Install command for PR-3 (exact, no caret; the ticket says pin 1.14.x):
  `pnpm --filter @terragon/www add @orpc/openapi@1.14.13 @orpc/zod@1.14.13 --save-exact`.
- Alternatives checked: hand-written Next routes (a second validator that drifts from the
  contract) and RPC-only (cannot be `curl`ed). Neither is taken. Upgrading the whole `@orpc/*`
  line to 1.16.x is out of scope.

---

## 3. Split into stacked PRs

Five PRs. PR-1 and PR-2 branch from `main` and are independent of each other; PR-3 stacks on
PR-2; PR-4 and PR-5 stack on PR-3. Each is independently mergeable and leaves `main` working.

| PR    | Branch                         | Content                                                                                                                                                                                                                                                                                                    | Depends on                                                      | Size (est. changed lines, tests incl.) |
| :---- | :----------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------- | :------------------------------------- |
| PR-1  | `fix/728-legacy-put-org-guard` | The motivating bug: legacy PUT and DELETE accept an explicit org and refuse a mismatch (AC-13). Extract the repo-write-access check into a lib module (no behavior change).                                                                                                                                | main                                                            | ~250                                   |
| PR-2  | `feat/728-egress-foundations`  | Shared, surface-free: per-entry classifier, multi-tenant host detection and warnings, code lists in `@terragon/types`, the `repo_egress_audit_log` table, migration, model (record/list). Ships the expand migration first, as AGENTS.md orders.                                                           | main                                                            | ~900                                   |
| PR-3  | `feat/728-egress-api`          | `@orpc/openapi` + `@orpc/zod`, `egress.{get,update,history,list}` in the contract, base SERVICE_UNAVAILABLE, principal middleware (token or session, explicit org), handlers, `/api/v1` REST mount + `openapi.json`, `x-api-version` on both mounts, rate limit, the effective view, PostHog event, tests. | PR-2 (rebases on PR-1 when both open)                           | ~1,500                                 |
| PR-4  | `feat/728-egress-settings-ui`  | Settings → Egress page, panel, React Query hooks over REST, dialogs, component tests, one e2e spec.                                                                                                                                                                                                        | PR-3                                                            | ~1,400                                 |
| PR-5  | `docs/728-egress-api`          | `api/egress.mdx`, nav and links, release notes + `RELEASE_NOTES_VERSION` 18 → 19.                                                                                                                                                                                                                          | PR-3 (release-note text names PR-4's page, so merge after PR-4) | ~350                                   |
| (CLI) | on #617                        | `automata egress …` commands, AC-11 and the `[CLI]` parts of AC-5/6/8/10.                                                                                                                                                                                                                                  | #617, PR-3                                                      | not here                               |

PR-3 is the largest. If review wants it smaller, cut along this seam: PR-3a = contract + middleware

- `get`/`list`/`history` (read-only), PR-3b = `update` + rate limit + PostHog. Both keep the REST
  mount and the OpenAPI document in 3a.

Order to merge and deploy: PR-1 (any time) → PR-2 → **`migrate.yml` applies
`2026-11-24-repo-egress-audit-log` on prod** → PR-3 → www deploy → PR-4 → PR-5.

### 3.1 File ownership map

| File                                                                                                                                                                             | PR  | Change                                                                                                                                                                                                  |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/www/src/lib/repo-write-access.ts` (new)                                                                                                                                    | 1   | `checkRepoWriteAccess({db, userId, organizationId, repoFullName})` → `"allowed" \| "not_repo_admin" \| "lookup_failed"`; the logic moved from `route.ts:60-88`                                          |
| `apps/www/src/lib/repo-write-access.test.ts` (new)                                                                                                                               | 1   | org admin, repo admin, not admin, lookup failed                                                                                                                                                         |
| `apps/www/src/app/api/review-settings/[owner]/[repo]/route.ts`                                                                                                                   | 1   | body `organizationId` on PUT, `?organizationId=` on DELETE; mismatch → 409; uses `checkRepoWriteAccess`; same copy as today                                                                             |
| `apps/www/src/app/api/review-settings/[owner]/[repo]/route.test.ts`, `route.permissions.test.ts`                                                                                 | 1   | AC-13 cases; permission suite moved onto the lib                                                                                                                                                        |
| `packages/types/src/egress.ts` (new)                                                                                                                                             | 2   | `EGRESS_ENTRY_CODES`, `EGRESS_ACCESS_REFUSALS`, `EGRESS_WARNING_CODES` as `as const` arrays (precedent: `CELL_EGRESS_GUARD_REASONS` in `packages/types/src/cell.ts`)                                    |
| `packages/shared/src/model/egress-policy.ts`                                                                                                                                     | 2   | export `canonicalizeEntries` (renamed `canonicalizeEgressEntries`); no logic change. `assertValidEntry` stays private: the classifier calls the public `findEgressPolicyError` per entry (validate fix) |
| `packages/shared/src/model/cell-egress.ts`                                                                                                                                       | 2   | export `normalizeEntry` as `normalizeCellEgressEntry`; no logic change                                                                                                                                  |
| `packages/shared/src/model/egress-entries.ts` (new)                                                                                                                              | 2   | `classifyEgressEntries`, `detectMultiTenantUploadHost`, `egressWarnings`                                                                                                                                |
| `packages/shared/src/model/egress-entries.test.ts` (new)                                                                                                                         | 2   | code table, parity, warnings                                                                                                                                                                            |
| `packages/shared/src/db/schema.ts`                                                                                                                                               | 2   | `repoEgressAuditLog` table                                                                                                                                                                              |
| `packages/shared/src/db/types.ts`                                                                                                                                                | 2   | `RepoEgressAuditLog` row type (follow the file's existing `InferSelectModel` pattern)                                                                                                                   |
| `packages/shared/src/model/repo-egress-audit-log.ts` (new) + `.test.ts`                                                                                                          | 2   | `recordRepoEgressChange`, `listRepoEgressChanges` (insert and list only; no update/delete export)                                                                                                       |
| `deploy/migrations/2026-11-24-repo-egress-audit-log.sql` (new)                                                                                                                   | 2   | expand migration                                                                                                                                                                                        |
| `packages/migrate/src/expected-migrations.ts`                                                                                                                                    | 2   | append the id                                                                                                                                                                                           |
| `packages/cli-api-contract/src/index.ts`                                                                                                                                         | 3   | base SERVICE_UNAVAILABLE; `egress.*` procedures with `.route()`                                                                                                                                         |
| `packages/cli-api-contract/package.json`                                                                                                                                         | 3   | add `"@terragon/types": "workspace:*"`                                                                                                                                                                  |
| `apps/www/package.json`, `pnpm-lock.yaml`                                                                                                                                        | 3   | `@orpc/openapi@1.14.13`, `@orpc/zod@1.14.13` (exact)                                                                                                                                                    |
| `apps/www/src/server/orpc/principal.ts` (new) + `.test.ts`                                                                                                                       | 3   | token-or-session principal, Bearer adapter, `{org}` resolution                                                                                                                                          |
| `apps/www/src/server/orpc/egress-router.ts` (new) + `.test.ts`                                                                                                                   | 3   | the four handlers                                                                                                                                                                                       |
| `apps/www/src/server/orpc/cli-router.ts`                                                                                                                                         | 3   | split the middleware (token-only for `threads`/`auth`, principal for `egress`); declared SERVICE_UNAVAILABLE                                                                                            |
| `apps/www/src/server/orpc/cli-router.test.ts`                                                                                                                                    | 3   | the 503 case asserts a declared error                                                                                                                                                                   |
| `apps/www/src/server/orpc/contract-conformance.test.ts` (new)                                                                                                                    | 3   | every thrown code is declared                                                                                                                                                                           |
| `apps/www/src/server/orpc/api-version.ts` (new)                                                                                                                                  | 3   | `API_VERSION = "1"` and the header helper used by both mounts                                                                                                                                           |
| `apps/www/src/app/api/cli/[[...slug]]/route.ts`                                                                                                                                  | 3   | add `x-api-version: 1`                                                                                                                                                                                  |
| `apps/www/src/app/api/v1/[[...rest]]/route.ts` (new)                                                                                                                             | 3   | `OpenAPIHandler` over `{ egress }` only, `GET /api/v1/openapi.json`, `x-api-version`, no wildcard CORS                                                                                                  |
| `apps/www/src/app/api/v1/[[...rest]]/route.test.ts` (new)                                                                                                                        | 3   | REST end-to-end on throwaway Postgres                                                                                                                                                                   |
| `apps/www/src/server-lib/egress/repo-egress-view.ts` (new) + `.test.ts`                                                                                                          | 3   | `getRepoEgressView` (box via `egressPolicyFromRow`, cell via `planCellEgressForRepo`)                                                                                                                   |
| `apps/www/src/server-lib/egress/repo-org.ts` (new) + `.test.ts`                                                                                                                  | 3   | `isRepoInOrganization` (§4.4)                                                                                                                                                                           |
| `apps/www/src/lib/rate-limit.ts`                                                                                                                                                 | 3   | `cliEgressWriteRateLimit` + `checkCliEgressWriteRateLimit`                                                                                                                                              |
| `apps/www/src/app/(sidebar)/(site-header)/settings/egress/page.tsx` (new)                                                                                                        | 4   | page                                                                                                                                                                                                    |
| `apps/www/src/components/settings/settings-layout.tsx`                                                                                                                           | 4   | nav item "Egress", scope `organization`                                                                                                                                                                 |
| `apps/www/src/components/settings/tab/egress.tsx` (new)                                                                                                                          | 4   | repo register                                                                                                                                                                                           |
| `apps/www/src/components/settings/egress/*.tsx` (new: `egress-panel`, `effective-egress-register`, `host-list-editor`, `confirm-domain-dialog`, `egress-history`) + `*.test.tsx` | 4   | panel                                                                                                                                                                                                   |
| `apps/www/src/queries/egress-queries.ts` (new)                                                                                                                                   | 4   | hooks; query key includes the page's org id                                                                                                                                                             |
| `apps/www/e2e/specs/egress-second-org.e2e.ts` (new); `apps/www/e2e/support/*` GitHub fixture for `/repos/{o}/{r}/installation`                                                   | 4   | e2e                                                                                                                                                                                                     |
| `apps/docs/content/docs/api/egress.mdx` (new)                                                                                                                                    | 5   | page                                                                                                                                                                                                    |
| `apps/docs/content/docs/meta.json`                                                                                                                                               | 5   | add `"api/egress"` under Configuration or Help & Resources                                                                                                                                              |
| `apps/docs/content/docs/security-permissions.mdx`, `integrations/cli.mdx`                                                                                                        | 5   | links                                                                                                                                                                                                   |
| `apps/docs/content/docs/resources/release-notes.mdx`, `apps/www/src/lib/constants.ts`                                                                                            | 5   | entry per `apps/docs/RELEASE_NOTES_TEMPLATE.md`; 18 → 19                                                                                                                                                |

No file is owned by two PRs.

---

## 4. Detailed design

### 4.1 PR-1: legacy PUT/DELETE org guard (AC-13)

- `PUT` body gains `organizationId?: unknown`. When present it must be a non-empty string
  (else `400 {error:"organizationId must be a string"}`). When it differs from
  `ctx.organizationId`: `409 {error:"active_org_changed", message: ACTIVE_ORGANIZATION_CHANGED_MESSAGE}`,
  checked **before** any read or write. Absent: today's behavior (OD-5 grace period).
- `DELETE` gets the same check from `?organizationId=` (G11: the same drift deletes egress).
  This widens the ticket slightly; it is the same bug on the sibling verb. If validate rejects
  it, drop the DELETE half.
- Validation of egress values on the legacy PUT stays as it is (OD-2).
- Move `requireRepoWriteAccess` (`route.ts:60-88`) to `apps/www/src/lib/repo-write-access.ts` as a
  pure decision (`"allowed" | "not_repo_admin" | "lookup_failed"`); the route maps it to today's
  exact 403 bodies. PR-3 maps the same decision to named codes. One rule, two renderings.
- Follow-up issue (filed at ship, self-contained per AP-003): "after one release, the legacy PUT
  requires `organizationId` for egress fields (400)", with the release date.
- The PR Review UI does not send `organizationId` yet. Out of scope; named as a follow-up.

### 4.2 PR-3: contract (`packages/cli-api-contract/src/index.ts`)

Code lists come from `@terragon/types/egress` (PR-2) so the contract, the classifier and the
tests read one list.

```ts
import { EGRESS_ACCESS_REFUSALS, EGRESS_ENTRY_CODES, EGRESS_WARNING_CODES } from "@terragon/types/egress";

// Base: SERVICE_UNAVAILABLE is thrown by the shared auth middleware for every procedure (G26).
const oc = ocBase.errors({
  UNAUTHORIZED: { message: "Unauthorized" },
  NOT_FOUND: { message: "Not found" },
  INTERNAL_ERROR: { message: "Internal server error" },
  RATE_LIMIT_EXCEEDED: { message: "Rate limit exceeded" },
  SERVICE_UNAVAILABLE: {
    status: 503,
    message: "Service temporarily unavailable",
    data: z.object({ reason: z.enum(["auth_unavailable", "github_unavailable"]) }).optional(),
  },
});

const EntryErrorSchema = z.object({
  code: z.enum(EGRESS_ENTRY_CODES),
  message: z.string(),
  entry: z.string().nullable(), // null when the validator refuses to echo it (G19b) or for set-level codes
  index: z.number().int().nullable(), // null for set-level codes (too_many_entries, level_unsupported_in_cell)
});

const egressOc = oc.errors({
  FORBIDDEN: { status: 403, message: "Forbidden", data: z.object({ reason: z.enum(EGRESS_ACCESS_REFUSALS) }) },
  BAD_REQUEST: { status: 400, message: "Invalid egress settings", data: z.object({ errors: z.array(EntryErrorSchema).min(1) }) },
  CONFLICT: { status: 409, message: "Changed by someone else", data: z.object({ currentUpdatedAt: z.string().nullable() }) },
});

const RepoPath = z.object({
  org: z.string().min(1).max(128),     // org id or slug (OD-8)
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
});

const Level = z.enum(["none", "ip_port", "domain"]);
const Layer = z.enum(["system", "platform", "registries", "repo"]);

const EgressView = z.object({
  org: z.object({ id: z.string(), slug: z.string() }), // the CLI prints it every time
  repo: z.string(),                                      // lowercased owner/name
  stored: z.object({
    level: Level.nullable(),
    allowlist: z.array(z.string()),
    registries: z.boolean().nullable(),
    updatedAt: z.string().nullable(),   // ISO 8601, the CAS token
    updatedByUserId: z.string().nullable(),
  }),
  box: z.object({
    enforced: z.boolean(),
    allowlist: z.array(z.object({ host: z.string(), layer: Layer })), // system | repo
    error: z.literal("invalid_policy").nullable(), // a stored value the builder throws on
  }),
  cell: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), entries: z.array(z.object({ host: z.string(), layer: Layer })), bundles: z.array(z.string()), digest: z.string() }),
    z.object({ ok: z.literal(false), code: z.enum(["egress_level_unsupported", "egress_compile_failed"]), reason: z.string().nullable() }),
  ]),
  warnings: z.array(z.object({ code: z.enum(EGRESS_WARNING_CODES), entry: z.string().nullable() })),
  canEdit: z.boolean(),                       // drives the UI read-only state
  readOnlyReason: z.enum(["not_repo_admin"]).nullable(),
  budget: z.object({ used: z.number().int(), max: z.number().int() }), // G19c: used = rendered count (platform + registries + repo, deduped), max = CELL_EGRESS_MAX_ENTRIES
});

const egressGet = egressOc
  .route({ method: "GET", path: "/v1/orgs/{org}/repos/{owner}/{repo}/egress", summary: "Read a repo's egress settings" })
  .input(RepoPath)
  .output(EgressView);

const egressUpdate = egressOc
  .route({ method: "PATCH", path: "/v1/orgs/{org}/repos/{owner}/{repo}/egress", summary: "Change a repo's egress settings" })
  .input(RepoPath.extend({
    level: Level.nullable().optional(),               // null = no policy; ip_port is accepted by the schema and refused by the handler with level_unsupported_in_cell (OD-1/OD-2)
    allowlist: z.array(z.string().max(253)).max(200).optional(), // full replace
    add: z.array(z.string().max(253)).max(100).optional(),
    remove: z.array(z.string().max(253)).max(100).optional(),
    registries: z.boolean().optional(),
    expectedUpdatedAt: z.string().nullable().optional(), // null = "I read no row"
    dryRun: z.boolean().optional(),                   // compute before/after, write nothing (UI preview, CLI --dry-run)
  }))
  .output(z.object({
    applied: z.boolean(),         // false for dryRun and for a no-op
    before: EgressView,
    after: EgressView,
    auditId: z.string().nullable(),
  }));

const HistoryEntry = z.object({
  id: z.string(), createdAt: z.string(), actorUserId: z.string(),
  authKind: z.enum(["api_key", "session"]),
  levelBefore: Level.nullable(), levelAfter: Level.nullable(),
  hostsAdded: z.array(z.string()), hostsRemoved: z.array(z.string()),
  registriesBefore: z.boolean().nullable(), registriesAfter: z.boolean().nullable(),
});

const egressHistory = egressOc
  .route({ method: "GET", path: "/v1/orgs/{org}/repos/{owner}/{repo}/egress/history" })
  .input(RepoPath.extend({ limit: z.coerce.number().int().min(1).max(100).default(50), before: z.string().optional() }))
  .output(z.object({ entries: z.array(HistoryEntry), nextBefore: z.string().nullable() }));

// Not in the ticket: the page register needs the org's stored rows with an explicit org
// (the legacy list reads the active org, G3). Stored fields only, no effective view.
const egressList = egressOc
  .route({ method: "GET", path: "/v1/orgs/{org}/egress" })
  .input(z.object({ org: RepoPath.shape.org }))
  .output(z.object({
    org: z.object({ id: z.string(), slug: z.string() }),
    repos: z.array(z.object({ repo: z.string(), level: Level.nullable(), allowlistCount: z.number().int(), registries: z.boolean().nullable(), updatedAt: z.string() })),
  }));

export const cliAPIContract = {
  threads: { … unchanged … },
  auth: { … unchanged … },
  egress: { get: egressGet, update: egressUpdate, history: egressHistory, list: egressList },
};
```

Update rules (handler-enforced, refused as `BAD_REQUEST` with `code: "invalid_input"` added to
`EGRESS_ENTRY_CODES`, `entry:null, index:null`):

- at least one of `level`, `allowlist`, `add`, `remove`, `registries`;
- `allowlist` is exclusive with `add`/`remove`;
- a host in both `add` and `remove`.

Semantics: the resulting row is `stored` with the patch applied (`allowlist` replaces; `add`
appends missing hosts, canonicalized; `remove` drops present hosts, a missing host is a no-op).
The **resulting** level and list are classified (§4.3), so a legacy-stored `*.x.com` blocks a
later `add` with its own index until it is removed. This is OD-2(a) applied to the whole result,
not only to the hosts being sent.

Schema-level validation failures (oRPC's own input `ValidationError`) are mapped by an
interceptor to the declared `BAD_REQUEST` with `code:"invalid_input"`, so no undeclared
error leaves the router (rule 6).

**Wire shape.** Both mounts return oRPC's error envelope. REST:
`403 {"defined":true,"code":"FORBIDDEN","status":403,"message":"Forbidden","data":{"reason":"org_mismatch"}}`.
The ticket's shorthand `403 org_mismatch` means exactly this (`code` + `data.reason`), and
`400 {code,message,entry,index}` means one element of `data.errors`. The docs page (PR-5)
shows the real envelope.

### 4.3 PR-2: classifier (`packages/shared/src/model/egress-entries.ts`)

```ts
export interface EgressEntryError {
  code: EgressEntryCode;
  message: string;
  entry: string | null;
  index: number | null;
}

export function classifyEgressEntries(input: {
  level: EgressPolicyLevel | null;
  entries: readonly string[]; // the resulting list, before canonicalization
  registries: boolean | null;
  brokerHost?: string; // the www public host; CLASSIFY_BROKER_PLACEHOLDER when absent (CLI)
}): {
  entries: string[]; // canonical
  errors: EgressEntryError[];
  budget: { used: number; max: number };
};
```

`index` refers to the **canonical** resulting list (trimmed, lowercased, empties dropped, deduped,
order-stable), which the result returns as `entries`; it is not the index in the request body.
`budget.used` is the rendered count of the compiled plan (`toAgent37Network(plan.set).allow.length`:
platform + registries + repo hosts, deduped), and `max` is `CELL_EGRESS_MAX_ENTRIES` (100). When the
plan does not compile, `used` is the same deduped count over the entries that passed.

Algorithm (maps the existing validators, re-parses nothing):

1. `level === "ip_port"` → one error `level_unsupported_in_cell` (`entry:null,index:null`), stop.
   (The same rule as `cellEgressForRepo`, `cell-egress-catalog.ts:144-146`.)
2. `level` null or `none`: entries are not enforced on either plane; still classify them, so
   nothing a cell cannot use is stored (OD-2). Canonicalize with `canonicalizeEgressEntries`.
3. For each canonical entry at its index `i` (all collected, not first-throw):
   - `normalizeCellEgressEntry(entry)` in a try. On `CellEgressError` map the code:
     `ip_literal`→`ip_not_allowed`, `ipv6`→`ipv6_not_allowed`, `port_not_443`→`port_not_allowed`,
     `invalid_host`→`invalid_host`, `public_suffix_wildcard`→`public_suffix_wildcard`. `entry` =
     `error.entry ?? null` (keeps the no-echo rule, G19b), `message` = `error.message`, `index` = `i`.
   - On success with `wildcard: true` → `wildcard_not_allowed` (the rule at
     `cell-egress-catalog.ts:189-195`).
   - Then `findEgressPolicyError({ egressPolicy: "domain", egressAllowlist: [entry] })` (the
     public box check, so `assertValidEntry` stays private): a message → `invalid_host`, message
     from the box. (Catches what the cell normalizer accepts and the box does not, e.g. a
     trailing dot.)
   - Any other `CellEgressError` code is unreachable for a single host; it rethrows (500). The
     parity test proves it unreachable.
4. Set level: when no per-entry error, run `planCellEgressForRepo({ repoFullName: "acme/check",
row: { egressPolicy: "domain", egressAllowlist: entries, cellEgressRegistries: registries },
brokerHost: "broker.invalid" })`. `reason: "too_many_entries"` → one `too_many_entries`
   (`entry:null,index:null`, message from the compiler). Any other refusal → rethrow (unreachable
   after step 3; asserted by the parity test).

Message words are the validators' own (G19, G13) so the API, UI and CLI say the same thing.

`detectMultiTenantUploadHost(host)`: exact `storage.googleapis.com`; any host equal to
`s3.amazonaws.com`, matching `s3.<region>.amazonaws.com`, `s3-<region>.amazonaws.com`, or ending in
`.s3.amazonaws.com` / `.s3.<region>.amazonaws.com`; `*.amazonaws.com`. The list is a frozen
constant with a comment linking #719; widening it is a code change with review.

`egressWarnings({ level, entries, registries })` returns, in this order:
`multi_tenant_upload_host` (per entry), `domain_governs_box` (level `domain`),
`no_policy_box_open` (level null), `registries_ignored` (registries true and level `none`,
G18), `cell_refuses_wildcard` / `cell_refuses_port` (only reachable for rows written through the
legacy PUT; computed from the classifier's errors on the stored list).

`EGRESS_WARNING_CODES` = those six. `EGRESS_ENTRY_CODES` = the eight ticket codes + `invalid_input`.
`EGRESS_ACCESS_REFUSALS` = `org_mismatch`, `org_forbidden`, `org_required`, `not_repo_admin`.

Why the UI does not import this module: `cell-egress.ts` imports `node:crypto` and `psl`
(G19a). The UI validates through `egress.update` with `dryRun: true` (debounced), which returns
the same `errors` and `warnings` from the same code. The CLI (node) imports the module directly
for its local exit-2 check.

### 4.4 PR-3: authorization and org resolution (`apps/www/src/server/orpc/principal.ts`)

Order of checks, each a fixed response (no step depends on whether a later object exists):

1. **Credential.** `X-Daemon-Token`, else `Authorization: Bearer <key>` copied into an
   `X-Daemon-Token` header bag, then `getDaemonTokenContext` (no second verifier). A token is
   present but unknown → `401 UNAUTHORIZED` (no fallback to the cookie). `tokenType === "daemon"`
   → 401 (rule 7, ADR-003 F1). Auth store down → `503 SERVICE_UNAVAILABLE {reason:"auth_unavailable"}`.
   No token → session via `auth.api.getSession({ headers })`; none → 401.
2. **Session writes are same-origin.** A session-authenticated `update` requires an `Origin`
   header equal to the public app origin (`nonLocalhostPublicAppUrl()`), else 401. Tokens are
   exempt. The `/api/v1` mount sends no `Access-Control-Allow-Origin` (G25: the `/api/cli`
   wildcard CORS is not copied).
3. **Org.**
   - Token: key org null → `403 org_required`. Resolve `{org}`: if it equals the key's org id,
     or is the slug of the key's org (`organization.slug` lookup by the key's org id), it
     matches; anything else → `403 org_mismatch`. Decided only from the key's own org, so it
     says nothing about other orgs (ticket's rule-7 note). Then **live membership** of the key's
     user in that org; gone → `403 org_forbidden` (G24).
   - Session: `getMembership` by id, else `getMembershipByOrganizationSlug`; none → `403 org_forbidden`
     (identical for an unknown org and a non-member, G31). `session.activeOrganizationId` is never read.
4. **Repo in org** (`isRepoInOrganization`, G12/G33): true when `{org}` already has a
   `repo_review_settings` row for the repo, or when `getRepoOrgAndMode({ installationId:
await getRepoInstallationId(owner, repo), repoFullName })` resolves to `{org}`. Otherwise
   `404 NOT_FOUND {message:"Repository not found"}`, byte-identical whether the repo is absent from
   GitHub, installed for another org, or has a row in another org. A GitHub failure →
   `503 SERVICE_UNAVAILABLE {reason:"github_unavailable"}`. Cache positive and negative results
   per isolate for 5 minutes (the `repo-admin.ts` pattern, bounded to 1000 entries).
5. **Write access** (`update`, including `dryRun`): `checkRepoWriteAccess` from PR-1 against
   `{org}`. `not_repo_admin` → `403 not_repo_admin`; `lookup_failed` →
   `503 SERVICE_UNAVAILABLE {reason:"github_unavailable"}` (retryable, exit 4 for the CLI). OD-7.
   Reads (`get`, `list`, `history`) need only membership; `get` reports `canEdit` from the same check.
6. **Rate limit** (`update` only, not `dryRun`): `checkCliEgressWriteRateLimit(userId)` → `RATE_LIMIT_EXCEEDED`.

### 4.5 PR-3: effective view (`apps/www/src/server-lib/egress/repo-egress-view.ts`)

```ts
export function getRepoEgressView(args: {
  org: { id: string; slug: string };
  repoFullName: string;
  row: RepoReviewSetting | undefined;
  canEdit: boolean;
}): EgressView;
```

- `box`: `egressPolicyFromRow(row, "worker")` (G15). `null` → `{enforced:false, allowlist:[], error:null}`.
  A throw → `{enforced:true, allowlist:[], error:"invalid_policy"}` (dispatch would fail those
  runs; the GET must not 500). Layers: an entry in `systemEgressHosts("worker")` is `system`, else `repo`.
- `cell`: `planCellEgressForRepo({ repoFullName, row, brokerHost: cellBrokerHost() })` (G18, G22).
  Layers: the platform bundle's hosts → `platform`, `CELL_EGRESS_CATALOG["automata/registries@1"].allow`
  → `registries`, else `repo`.
- `warnings`: `egressWarnings` from PR-2 on the stored fields.
- `budget` = the classifier's (§4.3): `used` = the compiled plan's rendered count (deduped, platform
  and registries included), `max` = `CELL_EGRESS_MAX_ENTRIES`. The view passes `cellBrokerHost()`.

No second copy of the box or cell rules: the view only calls the two existing functions.

### 4.6 PR-3: handlers (`apps/www/src/server/orpc/egress-router.ts`)

`update`, inside one `db.transaction`:

1. `SELECT pg_advisory_xact_lock(hashtextextended(<org id> || '/' || <repo>, 0))` serializes
   new-API writers on one (org, repo), including the no-row case, so two concurrent `add`s both
   land (AC-7).
2. Read `stored` (`getRepoReviewSetting` with the tx).
3. CAS: if `expectedUpdatedAt` was sent and differs from `stored?.updatedAt` at millisecond
   precision (or is `null` while a row exists) → `CONFLICT {currentUpdatedAt}`.
4. Compute the result, classify (§4.3), refuse with all errors at once.
5. `dryRun` or no change → return `{applied:false, before, after, auditId:null}`; nothing written.
6. `upsertRepoReviewSetting({ db: tx, organizationId: org.id, … , expectedUpdatedAt: stored?.updatedAt,
expectRowAbsent: stored ? undefined : true })`. The DB fence still protects against a racing
   legacy PUT, which does not take the lock; its `RepoReviewSettingConflictError` → `CONFLICT`.
   `organizationId` is always `{org}` resolved (never `ctx.organizationId`).
7. `recordRepoEgressChange` (PR-2) in the same tx. A throw rolls back both (AC-9).
8. After commit: PostHog `repo_egress_changed` with `organizationId`, `repoFullName`,
   `levelBefore/After`, `registriesBefore/After`, `addedCount`, `removedCount`, `authKind`.
   **No hosts** (test asserts no captured property contains any request host).

`get`: principal → repo-in-org → row → view. `history`: same gates, `listRepoEgressChanges`
(newest first, keyset cursor `(createdAt, id)` of the last entry, encoded opaquely on the wire). `list`: membership only.

Router wiring: `const base = implement(cliAPIContract).$context<{ headers: Headers }>()`;
`threads.*` and `auth.whoami` keep today's token-only middleware (unchanged behavior); `egress.*`
use the principal middleware. `cliRouter = base.router({ threads, auth, egress })`. The
`/api/cli` RPC mount serves the whole router; the `/api/v1` OpenAPI mount serves
`{ egress: cliRouter.egress }` only, so threads are not exposed as REST.

REST mount `apps/www/src/app/api/v1/[[...rest]]/route.ts`: `new OpenAPIHandler({ egress })`
with `prefix: "/api"`; `GET /api/v1/openapi.json` answered from `new OpenAPIGenerator({
schemaConverters: [new ZodToJsonSchemaConverter()] }).generate({ egress: cliAPIContract.egress },
{ info: { title: "Automata API", version: "1" }, components: { securitySchemes: { apiKey: {
type:"apiKey", in:"header", name:"X-Daemon-Token" }, bearer: { type:"http", scheme:"bearer" } } } })`,
memoized per isolate. `x-api-version: 1` set on every response of both mounts (rule 10).
`export const dynamic = "force-dynamic"`.

### 4.7 PR-2: audit table

`packages/shared/src/db/schema.ts` (next to `knowledgeAdminLog`):

```ts
/** Append-only log of repo egress changes (#728). One row per accepted change, written in the
 * same transaction. Hosts are stored here (our database) and never sent to PostHog. */
export const repoEgressAuditLog = pgTable(
  "repo_egress_audit_log",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    repoFullName: text("repo_full_name").notNull(),
    /** No FK on purpose: the log survives user deletion. */
    actorUserId: text("actor_user_id").notNull(),
    authKind: text("auth_kind").notNull().$type<"api_key" | "session">(),
    /** The apikey row id or the session row id (never a token value). */
    credentialId: text("credential_id"),
    levelBefore: text("level_before"),
    levelAfter: text("level_after"),
    hostsAdded: text("hosts_added").array().notNull(),
    hostsRemoved: text("hosts_removed").array().notNull(),
    registriesBefore: boolean("registries_before"),
    registriesAfter: boolean("registries_after"),
    createdAt: timestamp("created_at", { mode: "date", precision: 3 })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("repo_egress_audit_log_org_repo_created_index").on(
      table.organizationId,
      table.repoFullName,
      table.createdAt,
    ),
  ],
);
```

`hostsAdded`/`hostsRemoved` have no SQL default (the writer always supplies them), which keeps
the drift job's default comparison trivial.

Migration `deploy/migrations/2026-11-24-repo-egress-audit-log.sql`. The date is after today on
purpose: `main` already holds `2026-11-23-…` (G42), and a file that sorts before an applied one
is applied out of order with a warning. If another PR takes `2026-11-24` first, rename on rebase
to the next free date and update `EXPECTED_MIGRATION_IDS` with it.

```sql
-- migrate:expand
--
-- #728 (OD-3): append-only audit of repo egress changes, one row per accepted change, written
-- in the same transaction as the repo_review_settings update. New table, no backfill. Apply
-- BEFORE deploying the www revision that writes it (migrate.yml does this on green main CI).
-- Names and types match packages/shared/src/db/schema.ts (repoEgressAuditLog; schema-drift CI).

CREATE TABLE IF NOT EXISTS "repo_egress_audit_log" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "repo_full_name" text NOT NULL,
  "actor_user_id" text NOT NULL,
  "auth_kind" text NOT NULL,
  "credential_id" text,
  "level_before" text,
  "level_after" text,
  "hosts_added" text[] NOT NULL,
  "hosts_removed" text[] NOT NULL,
  "registries_before" boolean,
  "registries_after" boolean,
  "created_at" timestamp(3) DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "repo_egress_audit_log"
    ADD CONSTRAINT "repo_egress_audit_log_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The table is created in this file, so a plain CREATE INDEX blocks no traffic (lint L3).
CREATE INDEX IF NOT EXISTS "repo_egress_audit_log_org_repo_created_index"
  ON "repo_egress_audit_log" USING btree ("organization_id", "repo_full_name", "created_at");

-- Post-migration verification:
--   \d repo_egress_audit_log
--   pnpm exec tsx deploy/assert-schema-ready.ts
```

`packages/migrate/src/expected-migrations.ts`: append `"2026-11-24-repo-egress-audit-log"` as the
last entry. Rollback: stop writing; the table is never dropped while code reads it.

Model `packages/shared/src/model/repo-egress-audit-log.ts`:
`recordRepoEgressChange({ db, organizationId, repoFullName, actorUserId, authKind, credentialId,
before: {level, allowlist, registries}, after: {…} })` computes added/removed itself (canonical
sets, order-stable) and inserts one row, returning it (its id is `auditId`);
`listRepoEgressChanges({ db, organizationId, repoFullName, limit, before })` returns
`{ entries, nextBefore }`, newest first by `(createdAt desc, id desc)`, with the keyset cursor
`before = { createdAt, id }` (row comparison, so rows sharing a millisecond are neither skipped nor
repeated). `created_at` is `timestamp(3)` so a JS `Date` cursor round-trips exactly. The module
exports insert and list only: no update or delete.

**Re-home.** `repo_egress_audit_log` is in `REHOME_EXCLUDED_TABLES`
(`packages/shared/src/model/rehome-repos-to-org.ts`), like `knowledge_admin_log` and
`self_heal_admin_log`: the rows stay with the source org, so **a repo's egress audit history
restarts after a re-home** to another org. The rehome coverage guard test requires the entry.

Legacy PUT/DELETE do **not** write audit rows in this ticket (OD-2 keeps the legacy path
unchanged). This is a known gap to name in PR-3's description; a follow-up can add rows with
`auth_kind = "session"` from the legacy route if the owner wants every path audited.

### 4.8 PR-4: UI (DESIGN.md)

- Route `/settings/egress`, nav item "Egress" (scope `organization`), page title "Egress Settings"
  (no Terragon branding in new copy).
- The page pins `{org}` = the active org at mount (`useActiveOrganization`). When that value
  changes, the page clears every egress query and re-pins (DESIGN.md:188). All calls send the
  pinned org; a 404 after a cross-tab switch shows "This repository is not in <org>".
- Register: repos from `useUserReposQuery` merged with `egress.list` rows (orphans kept, as in
  PR Review), filter box, 32px rows divided by `line-soft`, each row: repo, level word,
  host count, ScopeBadge repo scope when a row exists. States: skeleton rows, empty sentence plus
  "Install the GitHub App" action, inline retry, truncation with tooltip.
- Panel (one expanded row at a time):
  - **Effective first**: two registers, "Box" and "Cell", each line `host` + layer
    (system/platform/registries@1/repo) + ScopeBadge for repo lines. A refused cell shows the
    refusal word and reason ("stays on the box: wildcard `*.x.com`").
  - **Mode**: Segmented `No policy` / `none` / `domain`. Stored `ip_port` shows a read-only line
    and the reason (OD-1).
  - **Host list editor**: add/remove; each change calls `update` with `dryRun:true` (debounced
    300 ms) and shows each `errors[i]` under its entry with the API's message; counter
    `used / budget.max`.
  - **Registries**: toggle listing the 17 hosts, "Widens a cell only. The box never reads it."
  - **Warnings**: `multi_tenant_upload_host` as the existing Alert with words plus a link to #719's
    reasoning; switching to `domain` opens `confirm-domain-dialog` with "This also restricts the
    box. Runs on the box can then reach only these hosts and the platform hosts"; switching to no
    policy shows "The box will be open."
  - **Preview**: before/after diff of both sets from the `dryRun` response, shown before Save.
  - **Save**: `update` with `expectedUpdatedAt`; `CONFLICT` → reload with "Changed by someone else.
    Reloaded the latest settings."
  - **Read-only**: `canEdit:false` → controls disabled with "Only organization admins or admins of
    this repository can change egress settings."
  - **History**: `egress.history`, newest first, "Load more" via `nextBefore`.
- No new hue; color only for state/scope.

### 4.9 PR-5: docs

`apps/docs/content/docs/api/egress.mdx`: minting a key on `/cli` and its org binding (the
active org at mint time; a key is refused for any other org); `X-Daemon-Token` and
`Authorization: Bearer`; `{org}` id or slug; each endpoint with `curl` (`acme/widgets`
placeholders); request/response schema; `x-api-version`; the oRPC error envelope and every
`code`/`data.reason`; level semantics on box and cell (G14, G18); the 98/81 host budget; the
multi-tenant upload host warning (#719); link to `/api/v1/openapi.json`. No Terragon branding on
the new page. Considered and not taken: `fumadocs-openapi` generation (a new dependency and a
build-time fetch for one page).

---

## 5. Tests

### PR-1

- `route.test.ts`: body `organizationId` = active org → 200; different → 409 `active_org_changed`,
  `upsertRepoReviewSetting` not called; absent → today's behavior; non-string → 400. Same three for
  DELETE via query. **Motivating bug** (DB-backed, throwaway Postgres): session active org B,
  body `organizationId: A` → 409, rows in A and B unchanged. Fails on today's code (writes B).
- `repo-write-access.test.ts`: the four decisions; the route keeps its exact 403 bodies.

### PR-2 (`packages/shared`, vitest)

- Code table (AC-6): `*.example.com`→`wildcard_not_allowed`, `example.com:8443`→`port_not_allowed`,
  `10.0.0.1`→`ip_not_allowed`, `::1`→`ipv6_not_allowed`, `exa mple`→`invalid_host` with
  `entry: null`, `*.co.uk`→`public_suffix_wildcard`, 99 valid hosts → `too_many_entries`
  (`index:null`), `ip_port` level → `level_unsupported_in_cell`. Several bad entries in one list →
  all returned with their indexes.
- Parity: for every entry the classifier accepts, `buildEgressPolicyShape` does not throw and
  `planCellEgressForRepo` is `ok` (with and without registries); for every entry it refuses,
  one of them refuses too. Run over `__fixtures__/cell-egress.ts` plus the table above. Proves
  step 3's "unreachable" claim.
- Warnings: each of the six codes; S3 variants; `storage.googleapis.com`.
- Audit model (DB): insert computes added/removed; list order and `(createdAt, id)` cursor
  (ties on one millisecond); org fence (org B's rows never returned for org A); rollback with the
  caller's tx; the module exports insert and list only.
- `rehome-repos-to-org.test.ts`: the coverage guard passes with `repo_egress_audit_log` excluded.
- `pnpm --filter @terragon/migrate exec vitest run --no-file-parallelism` (counts derived from
  `EXPECTED_MIGRATION_IDS`); `node deploy/lint-migrations.ts deploy/migrations`.

### PR-3 (`apps/www`, vitest, throwaway Postgres; GitHub calls stubbed)

Keys from `auth.api.createApiKey` with `metadata.organizationId` (the `cli-api-token.ts` shape).

- AC-1: own-org key, no row → 200, `x-api-version: 1`, `stored.level:null`, `box.enforced:false`,
  `cell.ok:true` with platform entries only.
- AC-2: PATCH with key for A; snapshot org B's row for the same repo before/after → byte-identical.
- AC-3: key for B on `{org}=A` → 403 `org_mismatch`, no row changes, zero audit rows; personal key
  → 403 `org_required`; daemon token → 401; Bearer form behaves like `X-Daemon-Token`.
- Token path, user removed from A after mint → 403 `org_forbidden`.
- AC-4: session active org B, `{org}=A`, member of A → A's row written, B's unchanged; not a
  member → 403 `org_forbidden`; `{org}` as slug and as id give the same result.
- Session `update` without a same-origin `Origin` → 401.
- AC-5: non-admin → 403 `not_repo_admin`; `get` returns `canEdit:false`.
- Not-found parity: repo installed for another org, repo absent on GitHub, repo with a row only in
  another org → identical response bytes (status, headers except date, body).
- AC-6 over REST: the table above → 400 with all `data.errors`; nothing written, no audit row.
- AC-7: two concurrent `add`s (`Promise.all`) of different hosts → both present; stale
  `expectedUpdatedAt` on full replace → 409 with `currentUpdatedAt`; legacy-PUT race → 409.
- AC-8: adding `storage.googleapis.com` → `multi_tenant_upload_host` in `after.warnings`.
- AC-9: one audit row per accepted change, same transaction (inject a failing audit insert →
  settings row unchanged); refused write → no row; `history` returns it; PostHog properties
  contain no request host.
- `dryRun` → `applied:false`, zero writes (row count and audit count unchanged).
- OpenAPI: `GET /api/v1/openapi.json` lists exactly the four operations with their paths and
  security schemes; threads are absent.
- `/api/cli` RPC: `egress.get` works with the same key; responses carry `x-api-version`.
- `cli-router.test.ts`: the 503 path is now the declared `SERVICE_UNAVAILABLE`.
- **Contract conformance** (`contract-conformance.test.ts`, the skill's matrix row 18 for the
  server): walk `egress-router.ts`, `principal.ts` and `cli-router.ts` for `errors.<CODE>(` and
  `new ORPCError("<CODE>"`; every code must be a key of the procedure's declared errors; no raw
  `new ORPCError` remains. Plus a type-level test that `EGRESS_ENTRY_CODES` in the contract and the
  classifier's return type are the same union.
- Rate limit: the limiter rejects → `RATE_LIMIT_EXCEEDED`.

Conformance-matrix rows that apply to the oRPC surface now: 5 (bogus/daemon token → one
request, no retry: asserted by the handler returning 401 without a second auth read), 6
(not-found parity), 7 (503 declared), 9 (canary key absent from response bodies, logs captured by
the test, and PostHog properties), 18 (declared errors). Rows 1-4, 8, 13, 14, 19, 20 are CLI
rows for #617.

### PR-4

- Component tests: inline codes and words from a mocked `dryRun` response; multi-tenant Alert;
  domain confirm dialog copy; read-only with reason; 409 reload copy; org switch clears the panel;
  `ip_port` read-only line; counter uses `budget.max`.
- e2e `egress-second-org.e2e.ts` (WORLD alpha/beta): sign in on alpha, page on alpha, add a host,
  save; switch beta in a second tab; assert in `pool` that beta's row for the same repo is
  unchanged and alpha's has the host. Needs the GitHub fixture for
  `GET /repos/{owner}/{repo}/installation` (G39).

### PR-5

- `pnpm --filter @terragon/docs exec fumadocs-mdx` builds; links resolve; `curl` examples use
  placeholders only.

---

## 6. Gates (from the repo `CLAUDE.md`, plus what this change touches)

Run from the worktree root. Format with the repo config only (the home `.editorconfig` sets tabs).

| Gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | PRs                                   |
| :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------ |
| `pnpm install --frozen-lockfile --prefer-offline` (PR-3 changes the lockfile: run `pnpm install` once after the `add`, then the frozen check)                                                                                                                                                                                                                                                                                                                                                                                     | all                                   |
| `pnpm --filter @terragon/docs exec fumadocs-mdx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | all (required before docs type-check) |
| `pnpm turbo tsc-check`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | all                                   |
| `pnpm --filter @terragon/cli-api-contract check` (no `tsc-check` script, G26b)                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 3                                     |
| `pnpm turbo lint`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | all                                   |
| `pnpm turbo format-check` and `pnpm exec prettier --check --no-editorconfig --config .prettierrc <changed files>`                                                                                                                                                                                                                                                                                                                                                                                                                 | all                                   |
| `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism` (docker Postgres)                                                                                                                                                                                                                                                                                                                                                                                                                                          | 2, 3                                  |
| `pnpm --filter @terragon/www exec vitest run --no-file-parallelism` (docker Postgres)                                                                                                                                                                                                                                                                                                                                                                                                                                             | 1, 3, 4                               |
| `node deploy/lint-migrations.ts deploy/migrations`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 2                                     |
| `pnpm --filter @terragon/migrate exec vitest run --no-file-parallelism`                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 2                                     |
| `node --test 'deploy/*.test.ts' 'deploy/github/*.test.ts'` (lint-migrations tests, public-repo guard)                                                                                                                                                                                                                                                                                                                                                                                                                             | 2, all for AC-14                      |
| Schema drift, locally: `docker run -d --name drift-pg -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:18`; `createdb -h localhost -p 55432 -U postgres a` and `b`; `DATABASE_URL=postgres://postgres:postgres@localhost:55432/a pnpm exec tsx deploy/migrate.ts --apply` (twice; second prints `applied 0 migration(s)`); `DATABASE_URL=…/b pnpm -C packages/shared exec drizzle-kit push --force`; `pnpm exec tsx deploy/schema-drift.ts --a …/a --b …/b`; `docker rm -f drift-pg`. CI runs the same job (`ci.yml:165-214`) | 2                                     |
| `pnpm --filter @terragon/www e2e` (Playwright, egress guard)                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 4                                     |
| `pnpm audit --prod --audit-level critical` (new `@orpc/*` deps)                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 3                                     |
| AC-14 check: `git diff origin/main...HEAD \| grep -iE <client-name pattern>` is empty (the pre-push gate the public-repo guard names)                                                                                                                                                                                                                                                                                                                                                                                             | all                                   |

`DATABASE_URL=… pnpm exec tsx deploy/assert-schema-ready.ts` is run by `migrate.yml` on prod
after PR-2 merges; the www deploy for PR-3 waits for it.

---

## 7. Where the ticket does not hold (summary)

1. **`effectiveEgress` in `packages/shared` cannot call `egressPolicyFromRow`**: it lives in
   apps/www with a `plane` argument (G15), and the name clashes with `effectiveEgressFields`
   (G16). The view is `getRepoEgressView` in apps/www, box = worker plane.
2. **The validators are first-throw and private** (G17, G19a): `canonicalizeEntries` and
   `normalizeEntry` are exported (moved, not copied) to map per entry; `assertValidEntry` stays
   private and the classifier calls the public `findEgressPolicyError` per entry instead. Wildcards are refused after compile, not by the normalizer.
3. **`entry` is null for non-echoable entries** (`exa mple` among them, G19b); `index` is always set.
4. **The 100-entry cap counts platform (2) and registries (17) hosts** (G19c): the repo budget is
   98, or 81 with registries.
5. **`Authorization: Bearer` is not supported today** (G23a); an adapter feeds the same verifier.
6. **No generic CLI rate limiter exists** (G28); a new one is added.
7. **"not_found repo" has no definition today** (G12); this spec defines it via the
   installation/binding resolver or an existing row, with a GitHub call (503 on failure, cached).
8. **A key keeps its org after the user leaves it** (G24); the token path also checks live membership.
9. **The legacy DELETE has the same drift bug** (G11); PR-1 guards it too, and the legacy paths
   still write no audit row (named gap).
10. **SERVICE_UNAVAILABLE is undeclared for every procedure**, not only egress (G26); declared at base.
11. **The UI cannot bundle the cell validator** (`node:crypto`, `psl`); it validates through `dryRun`.
12. **The migration must be dated `2026-11-24`** or later (G42).
13. **`cli-api-contract` is not covered by `turbo tsc-check`** (G26b).
14. **Error wire shape is oRPC's envelope** (§4.2): "403 org_mismatch" = `code:"FORBIDDEN"`,
    `data.reason:"org_mismatch"`.
15. Additions beyond the ticket, to confirm at validate: `egress.list`, `dryRun`, `canEdit`,
    `budget`, the `invalid_input` and `registries_ignored`/`no_policy_box_open` codes, the
    same-origin rule for session writes, and `lookup_failed` → 503 instead of 403.
