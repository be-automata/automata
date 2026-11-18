# #656 PR-E gate log

Branch `feat/656-e-worker`, off `main` at `5e302b76`. Spec: `docs/specs/656/spec-e.md`. Live evidence the design rests on: `docs/specs/656/probe-e-vault.md`.

## Gates run in the Claude sandbox (literal exits)

| Gate                                                               | Exit | Note                                                                                                                                         |
| :----------------------------------------------------------------- | :--- | :------------------------------------------------------------------------------------------------------------------------------------------- |
| per-phase `pnpm --filter <pkg> exec tsc --noEmit` (phases 1 to 7b) | 0    | worker, sandbox, types, shared, www                                                                                                          |
| `pnpm --filter @terragon/docs exec fumadocs-mdx`                   | 0    |                                                                                                                                              |
| `pnpm turbo tsc-check --force`                                     | 0    | 21 of 21 tasks                                                                                                                               |
| `pnpm turbo lint --force`                                          | 0    | 2 of 2 tasks                                                                                                                                 |
| worker unit tests for every file this PR touches or adds           | pass | `cell-config`, `cell-image-assets`, `cell-ttl`, `cell-www-client`, `www-client`, `cell-teardown`, `cell-run`, `workflow`, `workflow-cleanup` |
| sandbox `opensandbox-cell.test.ts` (T-COPYIN)                      | pass | 225 tests                                                                                                                                    |

The full worker and sandbox suites also contain tests that bind a loopback port (`startEgressProxy`, `startCredBroker`). They time out inside the Claude sandbox (local port binding is off) and are unrelated to this PR.

## Not run here (need Docker, Hatchet or the public internet)

- `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism` (`cell-authority.test.ts`: `leaseRefusal`)
- `pnpm --filter @terragon/www exec vitest run --no-file-parallelism` (`thread-status/route.test.ts`: T-LEASE-SUPERSEDED; `cell-control.test.ts`: T-STALE-ON)
- the full `HATCHET_IT=1` worker list in `CLAUDE.md` (the admission move in `workflow.ts`), then `docker compose -p automata-hatchet-it down -v --remove-orphans`
- `OPENSANDBOX_IT=1 OPENSANDBOX_IT_CELL_IMAGE=<digest> pnpm --filter @terragon/worker exec vitest run --no-file-parallelism src/agent-run/cell-run.integration.test.ts` (IT-E1)
- `OPENSANDBOX_IT=1 pnpm --filter @terragon/sandbox exec vitest run --no-file-parallelism src/providers/opensandbox-cell.integration.test.ts` (the new live `copyIn` case)
- `pnpm install --frozen-lockfile --prefer-offline` and `pnpm audit --prod --audit-level critical` (the lockfile importer was edited by hand: `@terragon/sandbox` added, `@terragon/types` moved to `dependencies`)

## Deviations from the spec

- The lockfile importer for `@terragon/worker` was edited by hand, because `pnpm install --lockfile-only` also rewrote unrelated `deprecated:` text.
- `cellCloneArgv` returns the list of argvs in order (clone, `checkout -B`, `fetch`), and `CELL_WRITE_MESSAGE_SH` removes the staged file whether or not the daemon write worked.
- T-CONFIG's "zero www calls" is zero `cell-plan` and `cell-teardown` calls: the pre-daemon throw still posts its one typed `run-terminal`, as the exit-path matrix (E1) says.
- A real marked run reads the cell config twice (selection, then the executor), because `RunExecutorInput` carries no config. The unit test pins one read at selection.
- `copyIn`'s `Blob` body is cast through `ArrayBuffer`: the worker's tsconfig has no DOM `BlobPart`.

## Docker and live suites (outside the Claude sandbox, 2026-11-18)

| gate                                                                              | exit | result                                    |
| :-------------------------------------------------------------------------------- | :--: | :---------------------------------------- |
| `pnpm install --frozen-lockfile`                                                  |  0   | accepts the worker importer edit          |
| worker vitest                                                                     |  0   | 2187 passed, 47 skipped                   |
| sandbox vitest                                                                    |  0   | 602 passed, 146 skipped                   |
| shared vitest                                                                     |  0   | 1786 passed                               |
| www vitest                                                                        |  0   | 4634 passed, 9 skipped                    |
| `HATCHET_IT=1` worker list, then the compose teardown                             |  0   | 65 passed, 1 skipped                      |
| `OPENSANDBOX_IT=1` sandbox live suite (includes the new `copyIn` case)            |  0   | 11/11                                     |
| `OPENSANDBOX_IT=1` IT-E1 (`cell-run.integration.test.ts`), cold, on an amd64 host |  0   | **5/5**, 231 s, no `osbit` container left |

**IT-E1 needs an amd64 host.** The cell image is `linux/amd64` only (`FROM --platform=linux/amd64`).

- On an arm64 Mac the nested daemon refuses the pull: `no matching manifest for linux/arm64/v8`.
- `DOCKER_DEFAULT_PLATFORM=linux/amd64` does not help either: the digest-pinned dind will not start
  under it (`up.sh` exits 125).
- It ran on a throwaway Hetzner cpx32 (amd64, `nbg1`) with root Docker, Node 24.11.1
  (checksum-verified) and the worktree's code only: no `.git`, `node_modules`, `.env*` or key files.

Two defects in the test itself, found live and fixed:

1. **The canary scan planted the canary in the logs it checks.** It passed the canary as one exec
   argument, and execd logs exec argv, so the cell container's logs contained it. The scan now joins
   two halves in the shell. It also reads only files written after the cell started
   (`find / -xdev -newer /proc/1`), plus every process's environ and cmdline. A full `grep /` of
   the batteries image took about 300 s, the whole budget. The image's own layers cannot hold a
   runtime secret, and PR-F's layer scan covers them in CI.
2. **A cold pull outlasted the create budget.** The multi-GB pull happened inside `create` (about
   2 min). The test now pre-pulls the image into the dind, as the box's runbook does (PR-G).
