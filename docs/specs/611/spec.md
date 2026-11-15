# Spec #611 — enforced egress for remote cells

Source of truth: GitHub issue be-automata/automata#611 (body below, as hardened; decision record `Verdict: READY` in the run state, ODs settled by the owner). Branch `feat/611-cell-egress-enforce` off main `e81f85a4`.

## Ticket

[ADR-014](https://github.com/be-automata/automata/blob/main/docs/adr/ADR-014-third-party-execution-compute.md) puts production egress in observe mode and treats observe as open egress. #606/#608 shipped the broker behind `CELL_BROKER_ENABLED` (off). This ticket makes the egress a remote cell receives plane-neutral, compiled once, enforced by the provider, and impossible to run in observe mode. It is a precondition for L3 PR 4 to turn the switch on. SOC 2 mapping: [docs/compliance/soc2-egress-alignment.md](https://github.com/be-automata/automata/blob/main/docs/compliance/soc2-egress-alignment.md) (CC6.6 at `:62`, RA register at `:69-80`).

## Reality check on be-automata/automata@2b0ab177

| Fact                                                                                                                                                                       | Where                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Agent37 `network`: `allow-all` (default), `deny-all`, `{allow:[hosts]}`. The allowlist filters by SNI on 443 only. DNS stays open (an exfiltration channel).               | ADR-014 `:23-26`                                                                                                                       |
| Production egress is observe; observe is not enforce                                                                                                                       | ADR-014 `:35`, `:51`                                                                                                                   |
| Policy: `egress_open` unless `caps.egress` is `none`/`allowlist` (`:78`), or when `configuration.egress_mode == "observe"` (`:81`). A missing `egress_mode` passes `:81`.  | `packages/shared/src/cell-policy/policy/cell.rego`                                                                                     |
| `secrets_exfiltrable_by_dns` (`:101`) and `provider_creds_exfiltrable_by_dns` (`:108`) need `dns_closed`, which the Agent37 allowlist cannot prove                         | same file                                                                                                                              |
| The resolver runs in SHADOW only, box profiles only; `egress_mode` comes from `egressPolicy ? "enforce" : "observe"`                                                       | `apps/www/src/server-lib/compute/resolve-cell-decision.ts:49`, `:138-139`, `:255-261`                                                  |
| `EgressPolicyShape {level, allowlist}`. System hosts are merged per plane (`worker`: callback + `api.anthropic.com`; `sandbox`: + github hosts). There is no `cell` plane. | `packages/shared/src/model/egress-policy.ts:20-24`, `:118-142`; `apps/www/src/server-lib/egress/resolve-egress-policy.ts:18`, `:40-63` |
| Proxy: a bare domain compiles to {443, 80} and `*.x` to subdomains only. `observe` allows all and audits it.                                                               | `packages/worker/src/agent-run/egress-proxy.ts:206-262`, `:531-566`                                                                    |
| Per-provider renderers exist for E2B/Daytona, but not for Agent37                                                                                                          | `packages/sandbox/src/egress.ts:264`, `:303`                                                                                           |
| Catalog: only `automata-box/{observe,enforce}` seeded; no Agent37 profile row                                                                                              | `deploy/migrations/2026-11-10-execution-profile-seed-automata-box.sql:32-35`                                                           |
| `CELL_BROKER_ENABLED` default false; read only by the route gate                                                                                                           | `packages/env/src/apps-www.ts:109`, `apps/www/src/lib/cell-broker-enabled.ts:8`                                                        |
| OPA gate: `build-cell-policy.sh --check` (fmt, check --strict, `opa test`, WASM byte match)                                                                                | `.github/workflows/ci.yml:91-104`                                                                                                      |

Not on main (spike 039, unverified here): the bundle compiler and renderers. Spike 039 measured 21/21, with both planes agreeing on 20 probes.

## Contract

- **`compileCellEgress(refs): CellEgressSet`** (in `packages/shared/src/model/`, pure). It always includes the platform bundle (broker host = the www public host, plus the model host per OD-2). The output is HTTPS/443 only, and `*.x` includes its apex. Deny wins. A deny inside an allowed wildcard, or an entry a plane cannot express, raises an error and is never widened. Templates only narrow. The set holds at most 100 entries, with no IPs, no IPv6 and no ports other than 443. `digest = sha256(canonical {entries, bundle versions})`.
- **`toAgent37Network(set): { allow: string[] }`**. It never returns `"allow-all"`, and it throws on an empty or over-cap set.
- **`toProxyShape(set): EgressPolicyShape`** (`level:"domain"`; every entry pinned `:443`, each wildcard also emits its apex). It exists so the worker plane and the cell plane cannot disagree.
- **Policy**: on the `managed` tier, deny `egress_not_enforced` unless `configuration.egress_mode == "enforce"` and `capabilities.egress == "allowlist"`. A missing value counts as not enforced.
- **Switch guard** (OD-1): a pure `assertCellEgressEnforced(profile)` that PR 4 calls before any create while `CELL_BROKER_ENABLED` is true. It refuses with a named reason.

## Acceptance Criteria

1. AC1: `compileCellEgress([])` returns exactly the platform entries, with a digest stable under ref reordering.
2. AC2: deny wins. `allow *.github.com` + `deny *.github.com` drops the entry. A deny under an allowed wildcard throws `inexpressible`.
3. AC3: a template entry that is not already allowed throws `template widens`. More than 100 entries, an IP, IPv6, or a `:80` pin each throw.
4. AC4: `toAgent37Network` output is a subset of the compiled set and never `"allow-all"`. An empty set throws.
5. AC5: for a fixed probe table, `matchEgress(toProxyShape(set), host, port)` equals Agent37 semantics (443-only, wildcard includes the apex) on every row, including `registry.npmjs.org:80` → deny on both.
6. AC6: Rego: a managed profile with `egress_mode` `observe` or missing, or `caps.egress` other than `allowlist`, is denied `egress_not_enforced`. The existing 17 cases still pass, and `cell.wasm` is rebuilt (`--check` green).
7. AC7: `assertCellEgressEnforced` refuses an observe, missing or unknown profile, and an empty allowlist, each with its own reason. It passes only for enforce + allowlist + a current evidence expiry.
8. AC8: the SOC 2 doc gains a row (or an RA entry) for the cell plane. It states that the Agent37 allowlist leaves DNS open (`dns_closed` unproven).

## Tests

- `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism src/model src/cell-policy`
- `pnpm --filter @terragon/worker exec vitest run --no-file-parallelism src/agent-run/egress-proxy` (AC5 parity, if the probe table lives there)
- `OPA=<pinned opa 1.10.0> packages/shared/scripts/build-cell-policy.sh --check`
- `pnpm turbo tsc-check`, `pnpm turbo lint`, `pnpm turbo format-check`

## Open decisions

All resolved by the owner on 2026-11-15:

- **OD-1, scope split: decided (default).**
  - This ticket ships the compiler, both renderers, the Rego rule (with `cell.wasm` rebuilt), the pure `assertCellEgressEnforced` guard and the SOC 2 row, all unit-tested.
  - PR 3/4 own the Agent37 profile catalog row and its conformance evidence, passing `network` at create, wiring the guard into the adapter, and any boot-time refusal.
- **OD-2, model host: decided.**
  - The platform bundle is the broker host plus `api.anthropic.com:443`, with a capped gateway token as the model credential (ADR-014 `:70`, `:157`).
  - No model route exists in the broker today. A broker-proxied route can later replace the entry; that changes the bundle digest, so cells are sealed again.
  - Agent37's LLM proxy is rejected, because it leaves `provider_endpoints_reachable` true.
- **OD-3, DNS stays open: decided (default).**
  - The broker bearer counts as a `cell.secrets` entry, and the `dns_closed` denial stands.
  - Until a DNS-closed profile exists, only public or synthetic cells with no secrets and trusted content are eligible.
  - An RA is recorded in `docs/compliance/soc2-egress-alignment.md` (AC8).
- **OD-4, where the switch guard runs: decided (default).** It runs per create, in the adapter (PR 4), while `CELL_BROKER_ENABLED` is true. The guard reads the current profile, so an expired evidence date stops new cells at once.

## UAT

- **T0 local:** the Tests commands above. Print the compiled set, digest and Agent37 rendering for `[]` and for one sample bundle.
- **T1a CI:** `ci.yml` cell-policy step and the shared/worker vitest jobs are green on the PR.
- **T2 Agent37 conformance probe (deferred, owner step, conformance key only, never committed):** create an instance with `toAgent37Network(compileCellEgress([]))`. Probe the broker host:443 (positive control → reachable), `example.org:443` (→ TLS access denied), `broker:80` (→ refused) and a DNS lookup (expect it to resolve, which documents OD-3). Then `PATCH deny-all` and delete, and record JSON evidence. **Not verified in this draft:** whether Agent37 accepts the broker's exact public host in the allow list.

## Decisions (settled 2026-11-15 by the owner)

- **OD-1 — scope split:** decided (default). This ticket ships the pure pieces, each unit-tested: `compileCellEgress`, `toAgent37Network`, `toProxyShape`, the Rego `egress_not_enforced` rule with `cell.wasm` rebuilt, the pure `assertCellEgressEnforced` guard, and the SOC 2 row/RA. PR 3/4 own the Agent37 catalog row and its conformance evidence, passing `network` at create, wiring the guard into the adapter, and any boot-time refusal. No `apps/www` code changes here.
- **OD-2 — model host:** decided. The platform bundle is the broker host plus `api.anthropic.com` (443), with a capped gateway token as the model credential (ADR-014 `:70`, `:157`). No model route exists in the broker on main@e81f85a4. A later broker-proxied model route replaces the entry; that changes the digest, so cells are sealed again. Agent37's LLM proxy is rejected (it leaves `provider_endpoints_reachable` true).
- **OD-3 — DNS stays open:** decided (default). The broker bearer counts as a `cell.secrets` entry and the `dns_closed` denials (`secrets_exfiltrable_by_dns`, `provider_creds_exfiltrable_by_dns`) stand. Until a DNS-closed profile exists, only public or synthetic cells with no secrets and trusted content are eligible. An RA is recorded in `docs/compliance/soc2-egress-alignment.md` (AC8).
- **OD-4 — guard site:** decided (default). Per create, in the adapter (PR 4), while `CELL_BROKER_ENABLED` is true. The guard reads the current profile, so an expired evidence date stops new cells at once. This PR only ships the pure function.

## Ground truth (verified at e81f85a4 on 2026-11-14)

Re-read in this worktree. The ticket's reality check was written at `2b0ab177`; three commits landed since (`git log 2b0ab177..e81f85a4`), and none of them touch the files below except `ci.yml` (one added line at :150, `run_pkg @terragon-labs/cli`, outside the cited range) and two new migrations. Deltas are marked **moved** or **correction**.

### Reality-check rows, re-verified

| Ticket claim                                                                  | Now                                                                                                                                                                                                                                                                                                                                         | Verdict                                                                                               |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| ADR-014 `:23-26` (`network` field, SNI on 443 only, DNS open)                 | `docs/adr/ADR-014-third-party-execution-compute.md:23` (`network` field: `"allow-all"` default, `"deny-all"`, `{ "allow": [hosts] }`), `:25` (`{allow}` filters TLS by SNI, refuses every port other than 443, DNS stays open, direct UDP to 8.8.8.8 answers)                                                                               | holds                                                                                                 |
| ADR-014 `:35`, `:51` (observe, observe is not enforce)                        | `:35` "Production egress is in observe mode…", `:51` "**Observe is not enforce.**"                                                                                                                                                                                                                                                          | holds                                                                                                 |
| `cell.rego` `:78`, `:81`, `:101`, `:108`                                      | `packages/shared/src/cell-policy/policy/cell.rego:78` (`egress_open` unless `caps.egress` in `{none, allowlist}`), `:81` (`egress_open` if `egress_mode == "observe"`; the default is `""`, so a missing mode passes), `:101-104` (`secrets_exfiltrable_by_dns`), `:108-112` (`provider_creds_exfiltrable_by_dns`)                          | holds                                                                                                 |
| Resolver SHADOW only, box only; `egress_mode` from the shape                  | `apps/www/src/server-lib/compute/resolve-cell-decision.ts:49` (`CELL_DECISION_MODE = "shadow"`), `:52-55` (`AUTOMATA_BOX = {provider: "automata-box", tier: "customer_box"}`), `:136-140` (`boxConfigurationFor`: `egressPolicy ? "enforce" : "observe"`), `:257-261` (the `egress_allowlist` overlay from the run's shape)                 | holds (ranges **moved** by ±2)                                                                        |
| `EgressPolicyShape`, system hosts per plane, no `cell` plane                  | `packages/shared/src/model/egress-policy.ts:20-24`, `:118-142`; `apps/www/src/server-lib/egress/resolve-egress-policy.ts:18` (`EgressPlane = "worker" \| "sandbox"`), `:40-64` (`systemEgressHosts`; worker = `[callbackHost, "api.anthropic.com"]` at :61, sandbox adds `github.com`, `api.github.com` at :63)                             | holds (function ends at :64)                                                                          |
| Proxy: bare = {443, 80}, `*.x` subdomains only; observe allows all and audits | `packages/worker/src/agent-run/egress-proxy.ts:206-216` (`CompiledEgressPolicy`), `:219-259` (`compileEgressPolicy`; bare → `[443, 80]` at :255), `:268-304` (`matchEgress`; wildcard = `h.endsWith(".suffix")` at :296, so the apex never matches; unpinned wildcard = 443 or 80 at :299), `:531-566` (`decide`; observe → allow, audited) | holds; the ticket's `:206-262` spans the type and the compiler, the wildcard rule is in `matchEgress` |
| Renderers for E2B/Daytona, none for Agent37                                   | `packages/sandbox/src/egress.ts:264` (`toE2bNetwork`), `:303` (`toDaytonaNetwork`); no Agent37 renderer anywhere (`git grep -n toAgent37Network` is empty)                                                                                                                                                                                  | holds                                                                                                 |
| Catalog: only `automata-box/{observe,enforce}`                                | `deploy/migrations/2026-11-10-execution-profile-seed-automata-box.sql:32-35`; the two migrations since (`2026-11-14-org-cell-workflow-write.sql`, `2026-11-15-cell-step-allowed-ref.sql`) add no profile                                                                                                                                    | holds                                                                                                 |
| `CELL_BROKER_ENABLED` default false, read only by the route gate              | `packages/env/src/apps-www.ts:109`; `apps/www/src/lib/cell-broker-enabled.ts:8`; its only callers are the three route files (`api/cell/git/[...path]`, `api/graphql`, `api/v3/[[...path]]`)                                                                                                                                                 | holds                                                                                                 |
| OPA gate in CI                                                                | `.github/workflows/ci.yml:91-104` (pinned `OPA_VERSION: "1.10.0"`, `OPA_SHA256: bebbfc16…ffe83`, the `opa_linux_amd64_static` release binary, then `build-cell-policy.sh --check`)                                                                                                                                                          | holds                                                                                                 |
| "the existing 17 cases"                                                       | **Correction.** `cell_test.rego` has **19** `test_` rules (`grep -c '^test_'`); "17/17" is the 2026-11-08 spike's count, quoted in the `cell.rego` header (:7). The TS mirror `cell-policy.test.ts` has **24** cases in `CASES` (:79-273) plus 4 more `it`s (:297-322)                                                                      | AC6 reads "the existing 19 Rego tests and 24 WASM cases"                                              |

Already done: **nothing.** `git grep` finds no `compileCellEgress`, `toAgent37Network`, `toProxyShape`, `assertCellEgressEnforced` or `egress_not_enforced`, and no `cell-egress*` file.

### The shape and matcher AC5 must agree with

- Shared shape (`packages/shared/src/model/egress-policy.ts:20-24`):

  ```ts
  export type EgressPolicyShape = {
    level: EgressPolicyLevel; // "none" | "ip_port" | "domain" (db/types.ts:532)
    /** FINAL, fully resolved control-plane-side; includes system entries. */
    allowlist: string[];
  };
  ```

- The worker mirrors it structurally, never imports it (`packages/worker/src/agent-run/types.ts:24-27`, header rule at :4-10: "importing across the plane boundary would pull control-plane code onto the customer box"). `egress-proxy.ts:64-66` imports and re-exports that mirror.
- The matcher (`egress-proxy.ts:268-272`):

  ```ts
  export function matchEgress(
    policy: EgressPolicyShape | CompiledEgressPolicy,
    host: string,
    port: number | null,
  ): boolean;
  ```

  - It trims, lowercases and strips one trailing dot from `host` (:277); an empty host is denied (:278-280).
  - Exact entries: `host` → ports {443, 80}; `host:N` → {N} (`HOST_PORT_RE = /^(.+):(\d{1,5})$/`, :199). A null port never matches an exact pin (:288-293).
  - Wildcards: `*.x` → suffix `.x`, so `x` itself does not match; `*.x:443` matches 443 only (:295-302).
  - No implicit loopback allow; host-local targets are refused by `decide()`, not by the matcher (comment at :281-287).

- The existing pure table test is `egress-proxy.test.ts:33-223` (`describe("matchEgress (pure decision table)")`, `it.each<[name, shape, host, port, expected]>`).
- **Plane boundary for the parity test.** `@terragon/worker` depends only on `agent`, `daemon`, `knowledge`, `utils` (`packages/worker/package.json:32-38`); nothing in the workspace depends on `@terragon/worker` (no `@terragon/worker` in any other `package.json`). None of `agent`, `daemon`, `knowledge`, `utils` depends on `@terragon/shared`, so a **`@terragon/shared` devDependency on `@terragon/worker`** creates no cycle. `egress-proxy.ts` imports only `node:*`, `./broker-common` (→ `@terragon/utils/broker-headers`) and `./types` (→ `@terragon/utils/payload-seal`, `@terragon/daemon/shared`, types only), all already resolvable from shared. Worker exports `"./*": "./src/*.ts"` (`package.json:24-29`), so the import is `@terragon/worker/agent-run/egress-proxy`. Precedent for a control-plane package test-depending on a plane package: `@terragon/shared` already devDepends on `@terragon/sandbox` (`packages/shared/package.json:60`).

### "The www public host" (the broker host)

- The cell broker routes are www routes (`apps/www/src/app/api/cell/git/[...path]/route.ts`, `api/v3`, `api/graphql`), so the broker host is the www app's public host.
- The existing derivation is `new URL(nonLocalhostPublicAppUrl()).host` in `systemEgressHosts` (`apps/www/src/server-lib/egress/resolve-egress-policy.ts:41`), the same "callback host" every run already reaches.
- `nonLocalhostPublicAppUrl()` (`apps/www/src/lib/server-utils.ts:12-27`):
  - development: `https://${NGROK_DOMAIN}` (deprecated) or `https://${LOCALHOST_PUBLIC_DOMAIN}` — both declared in `packages/env/src/apps-www.ts:61-63`;
  - test: `process.env.NEXT_PUBLIC_APP_URL`;
  - otherwise `publicAppUrl()` (`packages/env/src/next-public.ts:16-35`): `https://${NEXT_PUBLIC_VERCEL_BRANCH_URL}` on a Vercel preview, else **`NEXT_PUBLIC_APP_URL`** (throws when unset).
- So in production the broker host comes from **`NEXT_PUBLIC_APP_URL`**. It is read through `process.env` in `packages/env/src/next-public.ts`; it is not declared in the `apps-www.ts` envalid schema. No `.env` file was read.
- `URL.host` keeps a non-default port. The compiler takes a bare hostname (see Contract below); PR 4 passes `new URL(nonLocalhostPublicAppUrl()).hostname` after checking `protocol === "https:"` and `port === ""`, and the compiler rejects an IP or a port anyway.
- This PR reads no environment: `brokerHost` is injected.

### Existing renderers and helpers to mirror (adopt over build)

- `packages/sandbox/src/egress.ts`:
  - `normalizeEntries` (:231-240): trim, lowercase, drop empties, order-stable dedupe. **Private.**
  - `splitHostPort` (:247-253) on `HOST_PORT_RE` (:213). **Private.**
  - `mergeUnique` (:220-228). **Private.**
  - Cap pattern: "…supports at most N; refusing to truncate" thrown as a plain `Error` (:204-208, :334-338), never a silent truncate.
  - Unexpressible levels throw through one template (`daytonaUnsupported`, :297-301).
  - `@terragon/shared` must not import `@terragon/sandbox` at runtime (it is a devDependency), so these are patterns to copy, not functions to import.
- `packages/shared/src/model/egress-policy.ts` (same package, importable):
  - `IPV4_RE` (:33-34), `DOMAIN_RE` (:36-37: RFC-1035-ish labels, at least two labels, case-insensitive), `splitHostPort` (:39-43, `lastIndexOf(":")`), `isValidPort` (:45-49), `canonicalizeEntries` (:90-99). **All private today.**
  - Plan: export a small validator from this file instead of a second copy (Phase 1).
- Spike 039 (`~/.claude/skills/spike-findings-automata-platform/sources/039-egress-policy-bundles/bundles.ts`) is the measured blueprint (21/21, both planes agree on 20 probes). Its compiler and renderers are **not on main**. Two things in it are not carried over:
  - It sorts with `localeCompare` (locale-dependent); the digest here sorts by UTF-16 code unit (`a < b`).
  - It reads `BUNDLES` and `PLATFORM` as module globals; here the catalog and broker host are injected.

### Canonical digest helper

- `canonicalJson(value: unknown): string` exists twice:
  - `packages/utils/src/payload-seal.ts:189-202` (keys sorted recursively, `undefined` dropped, array holes → `null`), exported through `@terragon/utils/payload-seal` (`packages/utils/package.json:11`). The file has **no imports**.
  - `packages/shared/src/model/execution-profiles.ts:18-31` (same output for JSON values), used for `config_hash`. That file imports `drizzle-orm` and the DB schema.
- SHA-256 in shared: sync `createHash("sha256")` from `node:crypto` (`packages/shared/src/utils/opaque-token.ts:1,17`, `model/repo-skills.ts:37`, `self-heal/fingerprint.ts:29`); async `crypto.subtle` only in `executionProfileConfigHash` (`execution-profiles.ts:34-44`).
- **Decision:** `digest = createHash("sha256").update(canonicalJson({ bundles, entries })).digest("hex")`, with `canonicalJson` from `@terragon/utils/payload-seal` (pure, import-free, already a shared dependency) so the compiler stays synchronous and pulls in no DB module.

### `cell.rego` input shape and tests

- Input (`cell.rego:14-19`): `{now, cell: {data_class, repo_visibility, untrusted_content, irreversible, lane, secrets, needs_egress}, provenance, profile: {id, provider, tier, configuration, capabilities, evidence, legal}}`.
  - `caps := object.get(profile, "capabilities", {})` (:34).
  - `tier`: `managed if profile.tier == "managed"` (:122).
  - `configuration.egress_mode`: read at :81 with `object.get(profile, ["configuration", "egress_mode"], "")`.
  - `capabilities.egress`: read at :78 with `object.get(caps, "egress", "")`.
  - `decision := {"allow": count(reasons) == 0, "reasons": sort([r | some r in reasons])}` (:42). The reasons are already sorted in Rego (spike 054's "sort denials" is satisfied by the existing rule).
- The TS profile type (`cell-policy.ts:39-51`): `CellPolicyProfile {id; provider; tier: "customer_box" | "managed"; configuration?: Record<string, unknown>; capabilities: Record<string, unknown>; evidence?: {source; measured_at; expires_at}; legal?}`. `profileRecordForPolicy` (`execution-profiles.ts:103-136`) builds it from catalog + evidence rows; `evidence.expires_at` is the earliest row's expiry.
- `cell_test.rego` (19 tests). The shared fixture `allowlist_profile` (:19-35) is `tier: "managed"` with `capabilities.egress: "allowlist"` and **no `configuration`**. Under the new rule the happy path (:50-54) and `test_untrusted_content_allowed_when_dns_closed_and_endpoints_unreachable` (:139-144) would start failing, so the fixture gains `"configuration": {"egress_mode": "enforce"}`. `test_observe_mode_counts_as_open_egress` (:105-109) still works: `object.union` overrides the nested `egress_mode`. `test_customer_box_is_not_held_to_managed_bars` (:169-174) is unaffected (not managed).
- `cell-policy.test.ts` mirrors the same fixture (`allowlistProfile`, :32-52, no `configuration`) and has the same dependency: the cases at :80-85 ("synthetic cell … allowed") and :206-213 ("untrusted content allowed when DNS closed…") must keep passing, so the fixture gains `configuration: { egress_mode: "enforce" }` too.

### `build-cell-policy.sh --check` and OPA

- `packages/shared/scripts/build-cell-policy.sh`:
  - pins `OPA_VERSION="1.10.0"` (:18) and refuses any other version (:36-40);
  - takes OPA from `$OPA`, else `opa` on PATH (:23, :32-35); **no Docker**;
  - runs `opa fmt --fail --list` (:42-45), `opa check --strict` (:46), `opa test` (:47) over the policy directory;
  - builds only `cell.rego` from inside the policy directory with a relative path (`opa build -t wasm -e cell/decision`, :55) and extracts `policy.wasm` (:56-57);
  - `--check` compares it byte for byte with the committed `src/cell-policy/cell.wasm` (`cmp -s`, :59-64); without `--check` it overwrites `cell.wasm` (:66-67).
- CI uses the linux static release binary, verified by sha256 (`ci.yml:94-104`).
- **No `opa` on this machine's PATH** (`which opa` → not found). The implementer downloads the 1.10.0 static binary for this host into `$TMPDIR` and verifies it against the release's published `.sha256` before running it.
- **Not verified:** whether a darwin build of 1.10.0 emits the same `cell.wasm` bytes as the linux build. The script claims determinism only "for the same OPA version and Rego source". If CI `--check` reports drift after a local rebuild, rebuild `cell.wasm` with the linux binary (the CI binary, in a Linux container) and commit those bytes.

### The policy is evaluated through opa-wasm in a test

- Yes: `packages/shared/src/cell-policy/cell-policy.test.ts:275-322` loads the **committed** `cell.wasm` through `loadCellPolicy` (`cell-policy.ts:100-127`, `@open-policy-agent/opa-wasm` 1.10.0, `packages/shared/package.json:38`) with the host builtin `time.parse_rfc3339_ns` (:104), and runs the 24 `CASES` plus sorted/unique reasons, reuse, malformed-timestamp and precompiled-`Module` checks.
- Spike 054's landmine (`graph.reachable_paths` passes `opa test` and fails only at opa-wasm eval time) is therefore caught for this policy, **provided** every new Rego case also gets a WASM case. The new rule uses only `object.get`, `==` and set membership, which the existing policy already uses; no new builtin. Do not use `graph.*`, `regex.*`, `http.*` or any builtin the WASM target leaves to the host.

### SOC 2 doc format

- `docs/compliance/soc2-egress-alignment.md` (102 lines):
  - The deployment boundary section (:10-16) scopes every RA to the single-tenant pilot.
  - Control mapping table header at :59-60, columns `TSC | Control | Status | Evidence`. **CC6.6** is :62: "Per-repo egress policy (`none|ip_port|domain`) enforced at the network layer on all four planes: worker filtering proxy, Docker internal-net + sidecar, E2B native firewall, Daytona domainAllowList | Implemented | #101–#103, #105, #106; …".
  - Risk-acceptance register at :69-80: intro :71-73, header :75, rows RA-1 … RA-4 at :77-80, columns `ID | Accepted gap | Residual risk | Compensating controls | Remediation | Target (proposed)`. The next ID is **RA-5**.
  - The tables are prettier-aligned. Root `docs/` is not in any package's `format-check` (root `format-check` is `turbo format-check`), so the formatting is by hand or with prettier on the file.

## Contract (decided here)

### Where each function lives

| Function                                                                                            | File                                                      | Why there                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compileCellEgress`, `toAgent37Network`, `toProxyShape`, the entry validator use, `CellEgressError` | `packages/shared/src/model/cell-egress.ts` (new)          | Pure model next to `egress-policy.ts`, whose shape it renders. Imports: `node:crypto` (`createHash`), `@terragon/utils/payload-seal` (`canonicalJson`), `./egress-policy` (the shape type and the exported validator). No DB, no env, no clock. |
| `assertCellEgressEnforced`, `CellEgressNotEnforcedError`                                            | `packages/shared/src/model/cell-egress-guard.ts` (new)    | A separate add-on: PR 4's adapter mounts it without the compiler. Imports: `../cell-policy/cell-policy` (`CellPolicyProfile` type, `parseRfc3339Ns`). The clock is injected (`now`).                                                            |
| Entry validation                                                                                    | `packages/shared/src/model/egress-policy.ts` (edit)       | Export one helper over the existing `IPV4_RE`/`DOMAIN_RE`/`isValidPort` instead of copying them.                                                                                                                                                |
| `egress_not_enforced`                                                                               | `packages/shared/src/cell-policy/policy/cell.rego` (edit) | The existing allow_cell policy.                                                                                                                                                                                                                 |

### `cell-egress.ts` exports

```ts
/** A named, versioned bundle. `host` = that name; `*.host` = the name AND every name under it; 443 only. */
export interface CellEgressBundle {
  id: string; // "<namespace>/<name>@<version>"
  extends?: readonly string[];
  allow?: readonly string[];
  deny?: readonly string[];
}
export type CellEgressCatalog = Readonly<Record<string, CellEgressBundle>>;

export interface CellEgressEntry {
  name: string; // lowercase, no trailing dot, no port
  wildcard: boolean; // true = name and every subdomain
}
export interface CellEgressSet {
  entries: readonly CellEgressEntry[]; // deduped, sorted by key (code-unit order)
  bundles: readonly string[]; // every bundle id visited, platform first visited, sorted
  digest: string; // sha256 hex of canonicalJson({ bundles, entries: keys })
}
export interface CompileCellEgressDeps {
  brokerHost: string; // bare hostname of the www public host (see Ground truth)
  catalog?: CellEgressCatalog; // defaults to {} (platform only)
  narrowTo?: readonly string[]; // a template's entries; may only narrow
}

export const CELL_EGRESS_PLATFORM_BUNDLE = "automata/platform@1";
export const CELL_EGRESS_MODEL_HOST = "api.anthropic.com"; // OD-2
export const CELL_EGRESS_MAX_ENTRIES = 100; // Agent37 allow-list cap

export type CellEgressErrorCode =
  | "unknown_bundle"
  | "extends_cycle"
  | "platform_override"
  | "invalid_host"
  | "ip_literal"
  | "ipv6"
  | "port_not_443"
  | "platform_denied"
  | "inexpressible"
  | "template_widens"
  | "too_many_entries"
  | "empty_set";

export class CellEgressError extends Error {
  readonly code: CellEgressErrorCode;
  readonly entry?: string; // the offending entry or bundle id, when there is one
}

export function platformCellEgressBundle(brokerHost: string): CellEgressBundle;
export function compileCellEgress(
  refs: readonly string[],
  deps: CompileCellEgressDeps,
): CellEgressSet;
export function cellEgressKey(entry: CellEgressEntry): string; // "*.x" | "x"
export function toAgent37Network(set: CellEgressSet): { allow: string[] };
export function toProxyShape(set: CellEgressSet): EgressPolicyShape;
```

**Delta from the ticket:** the ticket writes `compileCellEgress(refs)`; the broker host is environment-derived, so it is injected as a second argument (`compileCellEgress([], { brokerHost })` for AC1).

Rules, in evaluation order (the first violation throws; the order is fixed so the code a test sees is stable):

1. **Visit.** The platform bundle (`{ id: CELL_EGRESS_PLATFORM_BUNDLE, allow: [brokerHost, CELL_EGRESS_MODEL_HOST] }`) is visited first, then each ref in the given order, depth-first through `extends`. An id missing from the catalog throws `unknown_bundle`; a repeat on the current chain throws `extends_cycle`; a catalog entry whose id is the platform id throws `platform_override`.
2. **Normalize and validate** every allow, deny and `narrowTo` entry: trim, lowercase, strip one trailing dot, then:
   - more than one `:`, or `[`/`]` → `ipv6`;
   - `host:N` with N ≠ 443 → `port_not_443` (`host:443` is accepted and stored as `host`);
   - an IPv4 literal (after stripping `*.`) → `ip_literal`;
   - anything that fails `DOMAIN_RE` (after stripping `*.`), including `*`, `*.com` and an empty string → `invalid_host`.
     The broker host goes through the same checks, so a dev `host:3000` or an IP is refused.
3. **Deny wins.** Drop every allow that some deny covers (`covers(d, a.name)`: an exact deny covers its name; a wildcard deny covers the name and its subdomains). If a deny covers a **platform** entry, throw `platform_denied` (the platform bundle is always included; a silent drop would cut the broker).
4. **No carve-outs.** If a kept wildcard allow covers a deny's name, throw `inexpressible` with the message `inexpressible: deny '<deny>' inside allowed '<allow>'` (Agent37 has no deny list, so it would allow it).
5. **Templates narrow.** With `narrowTo`, each entry must equal a kept key, or be an exact name covered by a kept wildcard; otherwise throw `template_widens` with the message `template widens: '<entry>' is not allowed by its bundles`. The result is then the platform entries plus the `narrowTo` entries.
6. **Dedupe and sort** by `cellEgressKey`, code-unit order (`a < b`, never `localeCompare`). An exact entry covered by a kept wildcard of the same name is kept as is (the renderers dedupe).
7. **Cap.** More than `CELL_EGRESS_MAX_ENTRIES` keys → `too_many_entries`.
8. **Digest.** `createHash("sha256").update(canonicalJson({ bundles, entries: entries.map(cellEgressKey) })).digest("hex")`. Ref order cannot change it (bundles and entries are both sorted).

Renderers:

- `toAgent37Network(set)`: `{ allow: set.entries.map(cellEgressKey) }`. The return type has no string variant, so `"allow-all"` cannot be returned. It throws `empty_set` on zero entries and `too_many_entries` above the cap (a hand-built set must not slip past the compiler's checks). It mirrors the sandbox renderers' "refusing to truncate" stance.
- `toProxyShape(set)`: `{ level: "domain", allowlist }` where an exact entry renders `name:443` and a wildcard renders `*.name:443` **and** `name:443`; the list is deduped order-stably. It throws `empty_set` on zero entries. There is no cap on the proxy (a wildcard emits two strings).

### `cell-egress-guard.ts` exports

```ts
export type CellEgressRefusal =
  | "unknown_profile" // null, undefined, {} or no id
  | "egress_mode_missing" // configuration.egress_mode absent
  | "egress_mode_observe"
  | "egress_mode_unknown" // any other value than "enforce"
  | "egress_not_allowlist" // capabilities.egress !== "allowlist"
  | "allowlist_empty" // capabilities.egress_allowlist not a non-empty string[]
  | "evidence_missing" // no evidence.expires_at
  | "evidence_invalid" // expires_at not RFC 3339 (parseRfc3339Ns throws)
  | "evidence_expired"; // expires_at <= now

export class CellEgressNotEnforcedError extends Error {
  readonly reason: CellEgressRefusal;
}

export function assertCellEgressEnforced(input: {
  profile: CellPolicyProfile | Record<string, never> | null | undefined;
  now: Date;
}): void;
```

- Checks run in the order listed; the first failure throws `CellEgressNotEnforcedError` with that `reason` and the message `cell egress not enforced: <reason>`. It never logs.
- Expiry: `parseRfc3339Ns(profile.evidence.expires_at) <= now.getTime() * 1e6` → `evidence_expired`, the same comparison `cell.rego:72-74` makes.
- It does not check `tier`: PR 4 calls it only for the cell adapter, and allow_cell already bars managed cases separately.

### Rego rule

In the managed-tier section of `cell.rego`:

```rego
# A managed cell's egress must be enforced by the provider: enforce mode and a measured allowlist.
# A missing mode or capability counts as not enforced.
reasons contains "egress_not_enforced" if {
	managed
	not managed_egress_enforced
}

managed_egress_enforced if {
	object.get(profile, ["configuration", "egress_mode"], "") == "enforce"
	object.get(caps, "egress", "") == "allowlist"
}
```

`egress_open` (:78, :81) is unchanged and still fires for observe on every tier. The `customer_box` resolver path (`AUTOMATA_BOX`) is not managed, so the shadow decisions for `automata-box/*` do not change.

## Acceptance Criteria (as refined)

- AC1: `compileCellEgress([], { brokerHost })` returns exactly `[brokerHost, "api.anthropic.com"]` (sorted), `bundles: ["automata/platform@1"]`, and a digest that is equal for `[a, b]` and `[b, a]` with a fixture catalog.
- AC2: allow `*.github.com` + deny `*.github.com` drops the entry; allow `*.example.org` + deny `admin.example.org` throws `inexpressible`.
- AC3: a `narrowTo` entry not already allowed throws `template_widens`; 101 entries throws `too_many_entries`; an IPv4 literal throws `ip_literal`; an IPv6 literal throws `ipv6`; `host:80` throws `port_not_443`.
- AC4: `toAgent37Network` output equals the compiled keys (a subset of the set), is never `"allow-all"`, and throws `empty_set` on an empty set.
- AC5: on the fixed probe table below, `matchEgress(toProxyShape(set), host, port)` equals the Agent37 model on every row.
- AC6: Rego: a managed profile with `egress_mode` `observe` or missing, or `caps.egress` other than `allowlist`, is denied `egress_not_enforced`. The existing 19 Rego tests and 24 WASM cases still pass (fixture updated), `cell.wasm` is rebuilt, and `--check` is green.
- AC7: `assertCellEgressEnforced` throws each `CellEgressRefusal` from its own input and passes only for enforce + allowlist + a non-empty allowlist + a current expiry.
- AC8: the SOC 2 doc has a cell-plane row and RA-5 stating that the Agent37 allowlist leaves DNS open (`dns_closed` unproven).

AC5 probe table (compile with `brokerHost: "broker.automata.test"`, catalog `{ "test/npm@1": { allow: ["registry.npmjs.org"] }, "test/wild@1": { allow: ["*.example.org"] } }`, refs `["test/npm@1", "test/wild@1"]`):

| #   | host                   | port   | both planes |
| --- | ---------------------- | ------ | ----------- |
| 1   | `broker.automata.test` | 443    | allow       |
| 2   | `broker.automata.test` | 80     | deny        |
| 3   | `api.anthropic.com`    | 443    | allow       |
| 4   | `registry.npmjs.org`   | 443    | allow       |
| 5   | `registry.npmjs.org`   | 80     | deny        |
| 6   | `example.org` (apex)   | 443    | allow       |
| 7   | `a.example.org`        | 443    | allow       |
| 8   | `a.b.example.org`      | 443    | allow       |
| 9   | `badexample.org`       | 443    | deny        |
| 10  | `example.org`          | 8443   | deny        |
| 11  | `REGISTRY.NPMJS.ORG.`  | 443    | allow       |
| 12  | `example.com`          | 443    | deny        |
| 13  | `104.16.0.1`           | 443    | deny        |
| 14  | `169.254.169.254`      | 80     | deny        |
| 15  | `localhost`            | 443    | deny        |
| 16  | `registry.npmjs.org`   | `null` | deny        |

The Agent37 side is a **test-local model** of its documented semantics (443 only, `*.x` covers the apex, exact otherwise, an IP never matches a name, lowercase, one trailing dot stripped), as in spike 039's `agent37Decide`. It is not a live call and is not exported. Row 16 has no Agent37 meaning (a TLS connection always has a port); the model returns deny for any port other than 443.

## Constraints for the implementer

- **Composable, reuse first.**
  - Reuse `canonicalJson` from `@terragon/utils/payload-seal`, `parseRfc3339Ns` and `CellPolicyProfile` from `../cell-policy/cell-policy`, and `EgressPolicyShape` from `./egress-policy`. Do not write a second canonical-JSON or RFC 3339 parser.
  - Export one validator from `egress-policy.ts` (for example `classifyEgressHost(host): "domain" | "ipv4" | "invalid"` over the existing `IPV4_RE`/`DOMAIN_RE`), and use it from `cell-egress.ts`. The existing `egress-policy.test.ts` must still pass unchanged.
  - Do not import `@terragon/sandbox` at runtime from shared (it is a devDependency); copy its patterns only.
  - Do not touch `packages/worker/src/agent-run/egress-proxy.ts`, `packages/sandbox/src/egress.ts`, `resolve-egress-policy.ts`, `resolve-cell-decision.ts`, the catalog, or `CELL_BROKER_ENABLED`. PR 3/4 own wiring (OD-1, OD-4).
- **Parity test placement.** AC5 lives in shared (`packages/shared/src/model/cell-egress-parity.test.ts`) and imports the real `matchEgress` from `@terragon/worker/agent-run/egress-proxy`, through a new `"@terragon/worker": "workspace:*"` **devDependency** of `@terragon/shared`. That is a workspace link already in `pnpm-lock.yaml` as an importer (`packages/worker:` at :1322), not a new external package; run `pnpm install` once so the lockfile records the link, and `pnpm install --frozen-lockfile --prefer-offline` must pass afterwards. The worker keeps its no-shared rule (`types.ts:4-10`): never the other direction. If shared's `tsc-check` cannot type-check the imported worker source, stop and report; do not copy `matchEgress`.
- **Rego.** Tabs, `opa fmt` clean, `opa check --strict` clean. Only builtins the policy already uses. Every new `cell_test.rego` case gets a matching `cell-policy.test.ts` case (the opa-wasm path, spike 054). Update the `cell.rego` header comment (:7-9) to name the new rule.
- **OPA.** The repo pins OPA **1.10.0** (`build-cell-policy.sh:18`, `ci.yml:96`). Download the static 1.10.0 release binary for this host to `$TMPDIR`, verify its published sha256, and run `OPA=$TMPDIR/opa packages/shared/scripts/build-cell-policy.sh` (rewrite), then `--check`. The script uses no Docker. If CI reports drift from a darwin-built `cell.wasm`, rebuild with the linux binary in a Linux container and commit those bytes.
- **Errors.** `CellEgressError` and `CellEgressNotEnforcedError` extend `Error`, set `name`, and carry a literal-union `code`/`reason`. Services throw; no try/catch in the pure modules except to map `parseRfc3339Ns`'s throw to `evidence_invalid`.
- **Formatting.** `pnpm exec prettier --no-editorconfig --config .prettierrc --write <files>` on every touched `.ts`, `.json` and `.md` (including `docs/compliance/soc2-egress-alignment.md` and this spec).
- **Docker / sandbox.** The shared vitest suite starts a docker compose Postgres through `src/test-global-setup.ts` even for a path filter, so run it unsandboxed. The OPA download needs `github.com` and its release CDN.
- **Content.** No client or customer names in code, tests, comments, the SOC 2 doc or the PR. Hosts in tests are `*.test`, `example.org`/`example.com` or the public hosts already in the repo (`api.anthropic.com`, `registry.npmjs.org`).
- **TypeScript (AGENTS.md).** Strict mode; `interface` for object shapes, literal unions instead of enums; no `any`, no `!` without a comment; `??` not `||`; kebab-case files; English identifiers; `readonly` inputs, never mutate parameters.

## Gates

Run in this order; each must be green before shipping:

```bash
pnpm install --frozen-lockfile --prefer-offline                      # after Phase 2's lockfile update
pnpm --filter @terragon/shared exec vitest run --no-file-parallelism src/model/cell-egress src/model/egress-policy src/cell-policy
OPA=$TMPDIR/opa packages/shared/scripts/build-cell-policy.sh --check  # OPA 1.10.0, sha256-verified
pnpm --filter @terragon/worker exec vitest run --no-file-parallelism src/agent-run/egress-proxy   # unchanged, regression only
pnpm turbo tsc-check
pnpm turbo lint
pnpm turbo format-check
pnpm --filter @terragon/shared exec vitest run --no-file-parallelism src/model src/cell-policy   # the ticket's gate, before ship
```

- The parity test lives in shared, so the worker suite is a regression gate only (no new worker test).
- The worker egress-proxy suite opens loopback servers (`egress-proxy.test.ts:225`); run it unsandboxed or with local binding allowed. Under a run proxy, unset `NODE_USE_ENV_PROXY` (docs/uat/UAT-367 notes three false failures).
- `@terragon/shared` and `@terragon/worker` have no `lint` script; `turbo lint` still runs for the packages that do.

## Phases (each ≤ 5 files)

1. **Compiler and renderers.** `packages/shared/src/model/egress-policy.ts` (export the validator), `packages/shared/src/model/cell-egress.ts` (new), `packages/shared/src/model/cell-egress.test.ts` (new: AC1-AC4, every `CellEgressErrorCode`, digest stability under ref reordering and a digest change when one bundle version changes, `toProxyShape` output for one exact and one wildcard entry). Gate: the shared vitest filter + `tsc-check`.
2. **Parity.** `packages/shared/package.json` (devDependency `@terragon/worker`), `pnpm-lock.yaml`, `packages/shared/src/model/cell-egress-parity.test.ts` (new: the 16-row table, AC5). Gate: frozen install, shared vitest, `tsc-check`.
3. **Switch guard.** `packages/shared/src/model/cell-egress-guard.ts` (new), `packages/shared/src/model/cell-egress-guard.test.ts` (new: one case per `CellEgressRefusal` and the passing case, with an evidence expiry 1 ms after `now` and one equal to `now`). Gate: shared vitest.
4. **Policy.** `packages/shared/src/cell-policy/policy/cell.rego`, `policy/cell_test.rego` (fixture gains `configuration.egress_mode: "enforce"`; new tests: managed observe, managed missing mode, managed `caps.egress: "none"` → `egress_not_enforced`; customer_box observe → `egress_open` but not `egress_not_enforced`; managed enforce + allowlist → allowed), `packages/shared/src/cell-policy/cell.wasm` (rebuilt), `packages/shared/src/cell-policy/cell-policy.test.ts` (same fixture change and the same new cases through opa-wasm). Gate: `build-cell-policy.sh --check` + shared vitest `src/cell-policy`.
5. **Compliance.** `docs/compliance/soc2-egress-alignment.md`:
   - a control-mapping row after :62, "CC6.6 — network boundaries (remote cells, ADR-014)": provider-enforced allowlist compiled once (`compileCellEgress`), rendered to Agent37 `{allow}` (SNI, 443 only) and to the proxy shape with a parity test; allow_cell denies `egress_not_enforced` on the managed tier; status "Partial — DNS open"; evidence #611 and ADR-014 `:23-26`;
   - RA-5 after :80: gap "Agent37 `{allow}` filters TLS by SNI but leaves DNS open (`dns_closed` unproven)"; residual "a cell can exfiltrate what it holds over DNS"; compensating "allow_cell keeps `secrets_exfiltrable_by_dns` and `provider_creds_exfiltrable_by_dns`; the broker bearer counts as a secret (OD-3), so only public or synthetic cells with no secrets and trusted content are eligible; `CELL_BROKER_ENABLED` stays off until PR 4"; remediation "a DNS-closed profile with conformance evidence"; target "re-review before PR 4 sets `CELL_BROKER_ENABLED`".
     Gate: prettier on the file.

## Not verified

- Agent37's wildcard semantics (`*.x` covers the apex), its 100-entry cap and its IPv6 refusal come from spike 039's model of the docs (`sources/039-egress-policy-bundles/README.md:27-33, :80`), not a live call. ADR-014 records only SNI/443 and open DNS. T2 (owner, deferred) is the live check.
- Whether Agent37 accepts the broker's exact public host in `allow` (the ticket's own T2 note).
- Whether a darwin OPA 1.10.0 build emits the same `cell.wasm` bytes as the linux build (see OPA above).
- Whether shared's `tsc-check` accepts the worker source imported by the parity test (Phase 2 checks it first).

## Validate round 1 (PASS_WITH_WARNINGS): fixes folded in

These override anything above.

- **Parity test placement (decided).** Shared gets a devDependency on `@terragon/worker`, and the parity test is `packages/shared/src/model/cell-egress-parity.test.ts`. The dependency graph has no cycle, and there is a precedent: shared already devDepends on `@terragon/sandbox` (`packages/shared/package.json:60`). Moving `matchEgress` to utils would edit worker runtime code. A parity test inside the worker would break the plane rule (`types.ts:4-10`).
- **W1, the apex of each wildcard.** `toAgent37Network` emits both `*.x` and `x` for every wildcard, so the result is correct whether or not Agent37 matches the apex. The 100-entry cap counts the **rendered** list. AC4 now reads: "a subset of the compiled keys plus the apex of each wildcard; never `allow-all`".
- **W2, hosts that are really IP literals.** A host whose last label is all digits (for example `999.1.1.1` or `1.2.3.4.5`) is classified as `ip_literal`, even when `DOMAIN_RE` accepts it. There is a test for it.
- **W3, the guard's evidence source.** A 10th refusal reason, `evidence_not_from_conformance`, mirrors `cell.rego:67-70`, and it has its own test.
- **W4, RA-5 has its own record.** The RA-5 row in `docs/compliance/soc2-egress-alignment.md` gives:

  - the owner (the tech lead, by role);
  - the date (2026-11-15) and the source (#611 OD-3);
  - the scope: the Agent37 SNI allowlist leaves DNS open, so `dns_closed` is unproven and cells with secrets are denied;
  - a target: a DNS-closed cell profile.

  The ground-truth date is corrected to 2026-11-15.

- **W5, a repurposed Rego test.** `test_enforce_mode_keeps_measured_egress`, and its copy in `cell-policy.test.ts`, now prove that a `customer_box` profile with no `configuration` is still allowed. That shows the new rule applies only to the managed tier.
- **W6, www regression checks.** The phase 4 gate also runs `apps/www/src/server-lib/compute/cell-policy.workerd.test.ts` and `apps/www/src/agent/hatchet/dispatch-cell-shadow.test.ts`.
- **W7, OPA on darwin.** `opa_darwin_arm64_static` 1.10.0 (sha256 checked against the published file) reproduces the committed `cell.wasm` bytes, so a Mac build is fine and Docker is not needed. CI rebuilds the file and compares it (`build-cell-policy.sh:59-63`).

## Phases (from the validator)

1. **Compiler and renderers.**
   - Files: `packages/shared/src/model/egress-policy.ts`, `packages/shared/src/model/cell-egress.ts`, `packages/shared/src/model/cell-egress.test.ts`.
   - Gate: `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism src/model/cell-egress src/model/egress-policy` and `pnpm --filter @terragon/shared tsc-check`.
2. **Parity.**
   - Files: `packages/shared/package.json`, `pnpm-lock.yaml`, `packages/shared/src/model/cell-egress-parity.test.ts`.
   - Gate: `pnpm install --frozen-lockfile --prefer-offline` must accept the lockfile diff, which may only add the importer's devDependency. Then the parity vitest run and tsc-check.
3. **Switch guard.**
   - Files: `packages/shared/src/model/cell-egress-guard.ts`, `packages/shared/src/model/cell-egress-guard.test.ts`.
   - Gate: the guard vitest run.
4. **Policy.**
   - Files: `packages/shared/src/cell-policy/policy/cell.rego`, `packages/shared/src/cell-policy/policy/cell_test.rego`, `packages/shared/src/cell-policy/cell.wasm`, `packages/shared/src/cell-policy/cell-policy.test.ts`.
   - Gate: `OPA=$TMPDIR/opa packages/shared/scripts/build-cell-policy.sh`, then the same command with `--check`. Then shared vitest over `src/cell-policy`, and the two www tests from W6.
5. **Compliance.**
   - File: `docs/compliance/soc2-egress-alignment.md`.
   - Gate: prettier on that file.

**Final gates:**

- the worker `egress-proxy` vitest;
- `pnpm turbo tsc-check`, `pnpm turbo lint` and `pnpm turbo format-check`;
- shared vitest over `src/model` and `src/cell-policy`.

The shared and worker suites run unsandboxed.

## Simplify + review round

The contract after the simplify pass and the roborev review.

- **`CellEgressRefusal`** (guard reasons, in check order): `unknown_profile`, `egress_mode_missing`, `egress_mode_observe`, `egress_mode_unknown`, `egress_not_allowlist`, `allowlist_empty`, `evidence_missing`, `evidence_not_from_conformance`, `evidence_invalid`, `evidence_expired`. The three mode reasons restore AC7: an observe, missing or unknown profile and an empty allowlist each get their own reason. All three mode reasons map to rego `egress_not_enforced`. `evidence_invalid` has no rego reason: the guard refuses it and `policy.evaluate` throws on the malformed expiry (the parity test asserts both).
- **`bundle_id_mismatch`** is a new `CellEgressErrorCode`. The catalog walk throws it when a catalog entry's `bundle.id` differs from its key.
- **Non-numeric ports are never echoed.** `port_not_443` echoes the raw entry only when the port is all digits. Otherwise it throws a generic "not echoed" message with `entry` undefined.
- **AC4, per W1.** `toAgent37Network` output is the compiled keys plus the apex of each wildcard. It is never `allow-all`, and an empty set throws `empty_set`.
- **`toProxyShape` also enforces the 100-entry cap**, over the rendered list, like `toAgent37Network`.
- **`IPV4_RE` export reverted.** It is private to its module again.
- **Deferred follow-ups:**
  - one host parser shared by `egress-policy`, `cell-egress` and the sandbox code;
  - folding `egress_not_enforced` into `egress_open`;
  - moving `toAgent37Network` next to the sandbox renderers in PR 3;
  - moving `matchEgress` to `utils`.
