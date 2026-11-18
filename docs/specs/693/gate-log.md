# #693 gate log

Branch `fix/693-cell-token-path-confusion`, off `origin/main` at `96c28905`. Run on 2026-11-18 on macOS arm64. The www, shared and sandbox suites ran with Docker Postgres. Spec: `docs/specs/693/spec.md`. Validate verdict: BLOCK; every finding was folded in (see the spec's Validation section).

## Ticket acceptance criteria

| #693 AC                                                                                                                                               | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                               | Status                                                                                                                                                                                                                  |
| :---------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. The live gate covers the path-confusion variants, in front of and behind the bound path, and asserts the canary absent and the placeholder present | `packages/sandbox/src/providers/opensandbox-cell.integration.test.ts`, scenario "daemon apiKey under path confusion (#693)". It covers 24 path variants and 2 authority variants. The literal-path control must receive the canary. Every variant must not, and every echoable variant must come back 200 with the placeholder. Harness: `https_raw`, unit-tested in `harness.test.ts` and smoke-run from the host against httpbin.org | **Met, live run 2026-11-18 (see "Live gate").** Deviations: the placeholder is asserted only where the echo server returns 200 (measured), and front/behind placement is applied wherever the variant's shape allows it |
| 2. The gate log records what the sidecar matches on                                                                                                   | Below, plus a pointer in `docs/specs/656/gate-log-b.md`                                                                                                                                                                                                                                                                                                                                                                                | Met                                                                                                                                                                                                                     |
| 3. `cell-plan` refuses the cell credential                                                                                                            | `apps/www/src/lib/cell-event-token.integration.test.ts`: "cell-plan refuses it with 401 before anything: no step, no bearer, no new key", plus the matrix row for `cell-plan`. Real auth and a real DB                                                                                                                                                                                                                                 | Met                                                                                                                                                                                                                     |
| 4. #656 AC 13 re-checked                                                                                                                              | With the cell token, every `/api/daemon/*` route answers 401 **from www** (the matrix: nine daemon routes, three broadcast routes, four proxies, the CLI router). It no longer depends on the sidecar's path match. The sidecar half rests on the upstream rule below and on the deferred live run                                                                                                                                     | Met: www half by the unit matrix, sidecar half by the 2026-11-18 live run                                                                                                                                               |

## What the sidecar matches on

Source: OpenSandbox `release-1.2.1`, `components/egress/mitmscripts/system.py`, read via `gh api`.

1. **Authority gate, before any binding.** HTTP/1 `Host` is validated strictly (`_live_h1_authority`). The authority must equal the connection SNI and the admission token's SNI, or the request gets 403 (:2003-2021). **Correction from the live run:** an absolute-form target that names another authority than `Host` is **not** refused; the token is injected, and the request still goes to the bound host on the bound path (see "Live gate").
2. **Binding selection.** The match uses the raw `flow.request.path` with the query removed (`_request_path` :1187). A non-wildcard pattern needs string equality (`_path_matches` :1326). A request that matches no binding is left untouched, even with an ambiguous encoding (`_apply_vault_binding` :2112-2124).
3. **Ambiguity rejection, only after a match.** Refused: `..` segments, a backslash or `%5c` at any decode depth, and a decoding that changes the set of matched bindings (`_reject_ambiguous_binding_path` :2085, `_path_is_ambiguous` :1195, `_path_decoding_changes_binding` :1243).
4. **Two bindings that can match one request** are refused at vault load (`components/egress/pkg/credentialvault/vault.go:1358-1380`).

What this means for the daemon binding:

- Only the literal `/api/daemon-event` (with any query), and a same-authority absolute-form target, carry the token. www routes both to `daemon-event`.
- Every other variant passes through untouched.
- **Not covered:** HTTP/2 (`_live_h2_authority`, `:path`). The raw probe is HTTP/1.1 only.

## Gates

All gates ran at the worktree root on the final tree (`e72cdc33` plus this log). `origin/main` was still `96c28905` at merge time, so `git merge --no-ff origin/main` was a no-op.

| Gate                                                                    | Exit | Result                                                                             |
| :---------------------------------------------------------------------- | :--- | :--------------------------------------------------------------------------------- |
| `CI=true pnpm install --frozen-lockfile --prefer-offline`               | 0    |                                                                                    |
| `pnpm --filter @terragon/docs exec fumadocs-mdx`                        | 0    |                                                                                    |
| `pnpm turbo tsc-check`                                                  | 0    | 21/21                                                                              |
| `pnpm turbo lint`                                                       | 0    | No ESLint warnings or errors                                                       |
| `pnpm turbo format-check`                                               | 0    | 18/18. Formatted with `prettier --config .prettierrc --no-editorconfig`            |
| `pnpm --filter @terragon/www exec vitest run --no-file-parallelism`     | 0    | 4670 passed, 9 skipped (341 files). Re-run after `/simplify`, with the same counts |
| `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism`  | 0    | 1786 passed (101 files)                                                            |
| `pnpm --filter @terragon/sandbox exec vitest run --no-file-parallelism` | 0    | 594 passed, 146 skipped. Re-run after `/simplify`                                  |
| gstack `/verify` (`gstack-checks run`)                                  | 0    | `READY_FOR_SHIP checks=tests`                                                      |
| worker suites                                                           | n/a  | Not run: `packages/worker` is untouched                                            |

The new tests do fail when the guard is missing. With the event-scoped check in `verifyDaemonApiKey` disabled, `cell-event-token.integration.test.ts` had 19 of 25 failing (every route row, the cell-plan refusal and the metadata check). With the guard back, all pass.

The `https_raw` probe was smoke-run from the host, with no sidecar, against httpbin.org:

- `/anything/x/../daemon-event`: 200, placeholder echoed;
- `/ANYTHING/...`: 404;
- absolute-form: 200;
- `Host: example.org`: 200, because httpbin ignores the mismatch. The sidecar is expected to answer 403.

Review:

- **Validate:** BLOCK, then folded (see the spec).
- **`/simplify`:** two agents covering reuse, simplification, efficiency and altitude. Fixed:

  - one shared `cappedExpiresAt` for the UTC expiry cap;
  - one shared `retry_markers` in the guest probe;
  - a wrong name in a comment;
  - the supersede moved off the response path (`waitUntil`);
  - the teardown revokes made parallel;
  - a hoisted `cellTokens`.

  Skipped, with the reason:

  - the token-class enum refactor of `verifyDaemonApiKey` (wider than this ticket);
  - dropping the name fallback in `isEventScopedKey` (deliberate fail-closed);
  - folding the cell revoke into `retireDaemonTokenById` (changes shared lifecycle code);
  - an `apikey (reference_id, name)` index (needs a migration; follow-up);
  - passing the org into the mint to skip one read (once per attempt).

## Live gate

`OPENSANDBOX_IT=1 pnpm --filter @terragon/sandbox exec vitest run --no-file-parallelism src/providers/opensandbox-cell.integration.test.ts`, OpenSandbox 1.2.1 in a throwaway dind, run outside the agent sandbox at the TL's request.

- **Run 1 (2026-11-18, 13:31–13:37 UTC, at `23a8bc3`): 9 of 11.** Authority variant 0 failed: an absolute-form target naming another authority (`GET https://example.org/anything/daemon-event`, TLS to the allowed host) was injected. The conformance-evidence test failed only as a consequence.
- **Decision (TL, 2026-11-18):** record the variant as injected to the bound host, with an assertion that proves the token stayed there, and propose upstream that the mismatch be refused.
- **Test change:** the variant moved out of the asserted-refused group into `foreignAbsolute`. It must return 200 with the canary echoed back by the bound host, and without example.org's page text (`Example Domain`). A token that reached another host would fail it. The `Host`-differs-from-SNI variant stays asserted refused.
- **Run 2 (2026-11-18, 15:23–15:28 UTC): 11 of 11, exit 0.** The runc conformance evidence was written. From the evidence:
  - control: injected on the literal path (`[true, false]`);
  - path confusion: 0 of 24 variants carry the token;
  - `Host` differs from SNI: not injected (`[false, true]`);
  - same route (`?x=1`, `https://<allowed>/…`): injected by design;
  - foreign absolute-form: `[true, false, false]`, so injected but answered by the bound host, with no example.org page.
- Teardown ran both times; no `osbit` containers left.
