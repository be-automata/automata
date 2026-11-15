# #611 gate log

Every command was run from the worktree root on 2026-11-15. The shared, worker and www suites ran unsandboxed. Every command below exited 0.

## Final gates

| Command                                                                                                                                                               | Exit | Result                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile --prefer-offline`                                                                                                                     | 0    | the lockfile adds only the shared importer entries for `@terragon/worker` (dev) and `psl` (already locked at 1.15.0) |
| `pnpm turbo tsc-check --force`                                                                                                                                        | 0    |                                                                                                                      |
| `pnpm turbo lint --force`                                                                                                                                             | 0    |                                                                                                                      |
| `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism src/model src/cell-policy`                                                                      | 0    | 1253 tests                                                                                                           |
| `pnpm --filter @terragon/worker exec vitest run --no-file-parallelism src/agent-run/egress-proxy`                                                                     | 0    | 95 tests                                                                                                             |
| `pnpm --filter @terragon/www exec vitest run --no-file-parallelism src/server-lib/compute/cell-policy.workerd.test.ts src/agent/hatchet/dispatch-cell-shadow.test.ts` | 0    | 6 tests (workerd)                                                                                                    |
| `OPA=<opa 1.10.0 darwin arm64 static, sha256 1ec7a71e…> packages/shared/scripts/build-cell-policy.sh --check`                                                         | 0    | `opa test` 24/24; cell.wasm matches cell.rego                                                                        |
| `pnpm exec prettier --no-editorconfig --config .prettierrc --check <changed files>`                                                                                   | 0    |                                                                                                                      |

`pnpm turbo format-check` exits 1 locally on files this branch does not touch. Turbo reads the local `~/.editorconfig`, which uses tabs. CI has no `~/.editorconfig` and is the authority.

The full worker suite (`vitest run`, 1926 tests) failed 1 test on one run and passed 1884/1884 on the rerun, with no code change in between. That one failure was a flake, not this change.

## Extra checks

- **www type-checks an import of `cell-egress` without a `paths` entry.** A temporary probe file in apps/www type-checked with exit 0 and was then removed. This proves the ambient `psl.d.ts` travels with the source.
- **psl runs in Workers.** `dist/psl.mjs` has no imports; punycode is bundled inside it.
- **UAT T0.** For `compileCellEgress([], { brokerHost: "automata.example.test" })`:
  - entries: `api.anthropic.com` and `automata.example.test`;
  - bundles: `automata/platform@1`;
  - Agent37 allow: the same two hosts;
  - proxy: `domain` level, both pinned to `:443`.

## Review passes

- **Validate:** PASS_WITH_WARNINGS. Fixes W1–W7 are folded into the spec.
- **Refinement:**
  - the bare-ASCII-host check now runs before lowercasing or echoing an entry;
  - an empty port is `invalid_host`;
  - a blank allowlist counts as empty.
- **`/simplify`:**

  - one render assert;
  - dead checks and redundant state removed;
  - `splitHostPort` reused;
  - shared fixtures;
  - a parity test between the guard and the policy.

  The mode-code merge was reverted, because AC7 needs a separate reason for each mode.

- **roborev:** six rounds, each "Pass", with the low findings fixed every round:

  - `bundle_id_mismatch`;
  - `evidence_invalid` parity;
  - no echo for ports, multi-colon entries, non-IPv6 entries or bare tokens;
  - no public-suffix wildcards (psl);
  - psl types that travel with the source;
  - fixtures under `__fixtures__`.

  Per the owner, the last round's two remaining lows (the `ip_literal` echo of a token like `x.42`; a public-suffix deny failing compile) are follow-ups, not more cycles. They are listed in the spec's "Final contract as shipped".
