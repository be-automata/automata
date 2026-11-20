# #709 gate log

Branch `ops/709-cell-evidence-renewal`, off `origin/main` = `34c43ad8`, 2026-11-19. Every
command ran from the worktree root. The Docker-backed suites ran outside the Claude sandbox,
which blocks the local Docker socket.

## Gates

| Gate                 | Command                                                                                                                                             | Exit | Result                                                            |
| :------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------- | :--: | :---------------------------------------------------------------- |
| install              | `pnpm install --frozen-lockfile --prefer-offline`                                                                                                   |  0   | lockfile in sync                                                  |
| docs codegen         | `pnpm --filter @terragon/docs exec fumadocs-mdx`                                                                                                    |  0   | needed before tsc                                                 |
| typecheck            | `pnpm turbo tsc-check`                                                                                                                              |  0   | every package                                                     |
| lint                 | `pnpm turbo lint`                                                                                                                                   |  0   | every package                                                     |
| format               | `pnpm turbo format-check`                                                                                                                           |  0   | every package                                                     |
| www unit (new)       | `pnpm --filter @terragon/www exec vitest run --no-file-parallelism src/server-lib/compute/cell-evidence-status.test.ts src/server-lib/cron.test.ts` |  0   | 39/39                                                             |
| www suite            | `pnpm --filter @terragon/www exec vitest run --no-file-parallelism`                                                                                 |  0   | 342 files passed, 1 skipped; 4680 tests passed, 9 skipped         |
| shared suite         | `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism`                                                                              |  0   | 101 files, 1787 tests passed                                      |
| worker deploy assets | `pnpm --filter @terragon/worker exec vitest run --no-file-parallelism src/agent-run/deploy-assets.test.ts`                                          |  0   | 107/107 (bash hygiene and shellcheck for the new script included) |
| shell                | `bash -n` and `shellcheck -s bash` on `opensandbox-evidence-renew.sh` and `install-opensandbox.sh`                                                  |  0   | clean                                                             |
| workflow             | `actionlint .github/workflows/synthetic.yml`                                                                                                        |  0   | clean                                                             |

## Behaviour of the renewal script (AC-3, AC-5)

`evidence/renew-harness.sh` runs the real `opensandbox-evidence-renew.sh` as root in a
throwaway `node:24` container, against stubs: an OpenSandbox list endpoint on `127.0.0.1:8090`
that checks the API-key header, a host `docker`, a `pnpm` standing in for the IT (it fails if
`PROFILE_EVIDENCE_SECRET` reached its environment, and prints a canary line), and a
`push-evidence.sh`. The checkout is a clean git repo owned by `automata`. The harness greps every
run's output for the fake secret and the IT canary. Output: `evidence/renew-harness.out.txt`.

| Scenario                                            | Result                                                                                                                                                   |
| :-------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a live cell (`items[0].metadata.automata = cell`)   | `skip: 1 cell(s) live …`, exit 0, nothing run                                                                                                            |
| `--dry-run` on an idle box                          | prints the plan, `nothing run, nothing pushed`, exit 0                                                                                                   |
| an `osbit=1` container up                           | `skip: an OPENSANDBOX_IT run is up …`, exit 0                                                                                                            |
| `items` not an array; empty page with `hasNextPage` | `FAIL … cannot count`, exit 1 (fail closed)                                                                                                              |
| idle                                                | `OPENSANDBOX_IT passed`, `renewed: rows=9 expiresAt=…`, exit 0; no root-owned file left under `packages/sandbox`; `.git/index` still owned by `automata` |
| www refuses                                         | `FAIL: www did not record the evidence (push exit 22, check_failed)`, exit 1                                                                             |
| the IT fails                                        | `FAIL: OPENSANDBOX_IT failed (exit 1); see …/last-it.log`, exit 1; the log is 0600                                                                       |
| a dirty checkout                                    | `FAIL … the evidence would be -dirty`, exit 1                                                                                                            |
| a second run holds the lock                         | `skip: another renewal holds …`, exit 0                                                                                                                  |

No run printed the secret or the IT output (`grep -c LEAK` = 0).

## The alert job (AC-4)

`evidence/workflow-sim.py` loads the `cell-evidence` job from `synthetic.yml` and runs its steps
in order, honouring each `if:`, with a fake `curl` (the status body) and a fake `gh` over an
issue store. Output: `evidence/workflow-sim.out.txt`.

| Sequence                                   | gh calls                         | Issues                  |
| :----------------------------------------- | :------------------------------- | :---------------------- |
| fresh (`ok`, 20 days)                      | list                             | none                    |
| `expiring`, 3 days                         | list, label create, issue create | #100 open               |
| `expiring` again                           | list                             | #100 open, no duplicate |
| `refused` / `evidence_expired`, still open | list                             | #100 open, no duplicate |
| renewed, `ok`                              | list, comment, close             | #100 closed             |
| `unconfigured`                             | none                             | unchanged               |
| `refused` / `evidence_missing`             | list, label create, issue create | #101 open               |
| body without `status`                      | the read step fails the job      | unchanged               |

The issue body holds the status, the enum reason, `expiresAt`, the days left, the renewal
command and the run URL: nothing else.
