# #727 part B: a cell's `gh` reads GitHub through the broker

Part A (#731, merged 2026-11-21 as `66d53dd`) put the referenced issue or PR into the mention
run's message. Part B gives a cell run the same read access a box run has: `gh issue view N`,
`gh pr view N` and `gh api repos/<owner>/<repo>/...` work inside an OpenSandbox cell, through the
existing read-only gh broker, with no credential in the guest. Decisions OD-1 and OD-3 of the
ticket apply (A and B as two PRs; REST restricted to the run's repo).

## 1. Ground truth (re-verified at `main` = `3a895870`, 2026-11-21)

| #   | Fact                                                                                                                                                                                                               | Where                                                                                                                 |
| :-- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------- |
| B1  | The broker serves `/api/v3/[[...path]]` and `/api/graphql`, behind `CELL_BROKER_ENABLED` (on in production).                                                                                                       | `apps/www/src/app/api/v3/[[...path]]/route.ts`, `apps/www/src/app/api/graphql/route.ts`                               |
| B2  | The broker authenticates a per-run bearer (`Bearer x`, `token x` or Basic) and binds it to the step's repo, lowercased, as `auth.owner` / `auth.repo`.                                                             | `packages/cell-broker/src/common.ts` `authorizeCellRequest` (`CellAuthorization`)                                     |
| B3  | Before this change, REST allowed GET/HEAD on **any** path (`restTarget`); GraphQL refuses mutations and bodies over 1 MiB.                                                                                         | `packages/cell-broker/src/gh.ts` `restTarget`, `graphqlTarget`                                                        |
| B4  | The cell vault's broker binding is `auth: "bearer"` on the broker host for `/api/cell/*`, `/api/v3/*`, `/api/graphql`, with **no placeholder**.                                                                    | `packages/shared/src/model/cell-create-plan.ts` `BROKER_PATHS`, `buildVault`                                          |
| B5  | The provider maps a bearer entry to OpenSandbox's `{type:"bearer", credential}`; a `placeholder` adds a header `substitutions` entry.                                                                              | `packages/sandbox/src/providers/opensandbox-cell.ts` `bindingAuth`                                                    |
| B6  | The model login already relies on a bearer binding with no substitution: the CLI sends `Bearer <placeholder>` and the vault puts the token there.                                                                  | `packages/worker/src/agent-run/cell-run.ts` bootstrap (`MODEL_PLACEHOLDER`)                                           |
| B7  | Nothing configured `gh` in a cell; `origin` is `https://<broker>/api/cell/git/<owner>/<repo>.git`, which gh cannot parse as a repo.                                                                                | `cell-run.ts` `bootstrap`; `cell-image.ts` `cellCloneArgv`                                                            |
| B8  | `cell-entry.sh` runs the daemon under `env -i` with an allowlist and exits 78 on a name matching `CELL_FORBIDDEN_ENV_PATTERN` (`TOKEN`, `AUTH`, ...), so a token env such as `GH_ENTERPRISE_TOKEN` cannot be used. | `deploy/images/cell/cell-entry.sh`; `cell-image.ts` `CELL_FORBIDDEN_ENV_PATTERN`, `CELL_ENV_ALLOWLIST`                |
| B9  | The settings `env` block reaches the agent's tools (it is how repo env reaches a cell, #706). `GH_` is a reserved repo-env prefix, so an owner cannot set or override `GH_*`.                                      | `cell-run.ts` bootstrap; `packages/worker/src/agent-run/daemon-env.ts` `RESERVED_REPO_ENV_PREFIXES`                   |
| B10 | `gh` is in the cell image (batteries base, `/usr/local/bin/gh`).                                                                                                                                                   | `deploy/images/cell/Dockerfile:18` (`FROM automata-batteries@sha256:…`); `deploy/images/batteries/Dockerfile:157-158` |
| B11 | The daemon's system prompt already says "You can use the gh cli to interact with github"; no batteries file sits at `~/.claude/CLAUDE.md`.                                                                         | `packages/daemon/src/claude.ts` `systemPrompt`; `deploy/images/batteries/Dockerfile`                                  |

**Proven before writing the bootstrap (ticket B.2).** A new OpenSandbox IT case
(`opensandbox-cell.integration.test.ts`, "#727 broker bearer") sends
`Authorization: token automata-cell-gh-placeholder` from a real cell, through a real OpenSandbox
1.2.1 egress proxy, to httpbin. With the **production binding shape** (bearer, no placeholder),
the request arrives with the credential and without the placeholder (httpbin joins a repeated
header, so an append would show both). A substitution binding behaves the same. So the
vault overwrites gh's header and the broker binding needs no change. Run:
`OPENSANDBOX_IT=1 pnpm --filter @terragon/sandbox exec vitest run --no-file-parallelism src/providers/opensandbox-cell.integration.test.ts -t "#727 broker bearer"` → 1 passed.

## 2. Design

1. **`cellGhSetup({brokerHost, repoFullName, botLogin})`** (`packages/worker/src/agent-run/cell-image.ts`),
   pure, validates every input it writes:
   - `hostsYml`: `<brokerHost>:` with `oauth_token: automata-cell-gh-placeholder`
     (`CELL_GH_TOKEN_PLACEHOLDER`, in `@terragon/types/cell`), the bot login and `git_protocol: https`.
   - `env`: `GH_HOST=<brokerHost>`, `GH_REPO=<brokerHost>/<owner>/<repo>`,
     `GH_CONFIG_DIR=/home/agent/.config/gh`, `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`.
   - Env, not argv or token: the names ride the settings `env` block (B9), never the daemon's
     process env, so `cell-entry.sh` is unaffected (B8) and none matches the forbidden pattern.
2. **Bootstrap** (`cell-run.ts`): `mkdir -p -m 700 ~/.config/gh`, write `hosts.yml` (600, agent),
   write `~/.claude/CLAUDE.md` with the read-only note (`CELL_GH_NOTE`, ticket B.3), and merge
   the gh env last into the settings `env` (`{...testDb, ...repoEnv, ...gh.env}`).
3. **OD-3 allowlist** (`packages/cell-broker/src/gh.ts`): REST forwards only
   `repos/<step owner>/<step repo>/...` (case-insensitive on the two segments), `rate_limit` and
   `meta`; everything else is `403 forbidden_path` before a token is minted. GraphQL unchanged.

Alternatives checked: `GH_ENTERPRISE_TOKEN` env (refused by `cell-entry.sh`, B8); a vault
`placeholder` substitution on the broker binding (works, but unneeded per the IT, and it would
change the binding the git clone already uses); `gh repo set-default` (still parses `origin`, B7).

**Residual risk, accepted.** A REST read under `repos/<o>/<r>/` can still reach a public fork in the same
network (`compare/main...other:branch`), and GraphQL can name another repo; the read token bounds what
either returns (OD-3 keeps GraphQL as it is).

## 3. Acceptance criteria covered (ticket numbering)

- **AC-5**: real gh with the cell's own config (`hosts.yml` + `GH_HOST`/`GH_REPO`, no token env)
  runs `gh issue view`, `gh pr view` and `gh api repos/o/r/issues/N` with no `-R`/`--hostname`
  (`apps/www/src/server-lib/cell-broker/real-gh.test.ts`, "#727 B").
- **AC-6**: `gh api -X POST`, a GraphQL mutation, `gh api user` and `gh api repos/acme/other` are 403
  and never reach GitHub (same test); OD-3 table (`gh.test.ts`).
- **AC-7**: the gh files hold the placeholder only (`cell-run.test.ts`, `cell-image-assets.test.ts`,
  real-gh "AC-7"); no gh env name matches the entry's forbidden pattern; the IT shows the guest
  header never carries the credential into a file.
- **AC-8** (production UAT) waits for the merge, the box deploy and a cell run.

## 4. Gates

`pnpm turbo tsc-check lint format-check --force`; vitest for `@terragon/worker`, `@terragon/www`,
`@terragon/sandbox`; the OpenSandbox IT case above.
