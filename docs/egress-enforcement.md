# Egress enforcement — provider planes (#66 slice 3)

Ops/deploy notes for sandbox-plane egress enforcement (Docker, E2B, Daytona).
Worker-plane (macOS) enforcement and its PF backstop live in
`deploy/PILOT-RUNBOOK.md` ("Egress enforcement backstop").

The control plane resolves a per-repo policy (`repoReviewSettings.egress_policy`
and its allowlist) into a **shape** — `{level, allowlist}`, system hosts (daemon
callback, `github.com`, `api.github.com`, `api.anthropic.com`) already merged —
and ships it on
`CreateSandboxOptions.egressPolicy`. Providers translate the shape via the pure
mappers in `packages/sandbox/src/egress.ts`. **No policy on the repo ⇒ every
provider's create path is unchanged** (rollback = clear the columns).

> ### ⚠️ KNOWN GAP: the system-host set breaks OAuth runs under an enforcing policy
>
> The four system hosts above are enough for a run that authenticates with an
> **API key**. They are NOT enough for a run that authenticates with a delivered
> **OAuth/subscription credential** (`WORKER_BOX_TRUST=owner`, and every
> in-sandbox run that receives the user's own credential).
>
> Anthropic's published requirements
> (<https://code.claude.com/docs/en/network-config#network-access-requirements>)
> list `platform.claude.com` as required for "OAuth token exchange, refresh,
> revocation — both Console and claude.ai sign-ins require it", plus `claude.ai`
> for account authentication. Neither is in the merged set, so under an
> enforcing policy the agent's token refresh is denied by the proxy.
>
> The symptom is NOT a clear auth error: the CLI reports an OAuth failure with
> no API call made, which reads as a dead credential rather than a blocked host.
> That is the same misleading signature recorded for `CLAUDE_CODE_SIMPLE` in the
> pilot's `worker-box.env`.
>
> Found while implementing #108; deliberately not fixed there because the merge
> happens control-plane-side and changing it alters every existing enforcing
> policy. Until it is fixed, treat "enforcing policy + owner-trust box" as an
> unsupported combination.

## Docker — internal network + proxy sidecar

Per sandbox with a policy, `docker-provider.ts`:

1. creates an `--internal` network `automata-egress-<container-name>` (no
   route out at all),
2. starts a sidecar `<container-name>-egress` (same base image) attached to
   BOTH that network and the default bridge, running the standalone filtering
   forward proxy (`packages/sandbox/src/egress-proxy-standalone.cjs`,
   bind-mounted read-only; policy shape delivered as `EGRESS_POLICY_JSON`),
3. runs the sandbox container ON the internal network with
   `HTTP(S)_PROXY`/`http(s)_proxy` pointed at the sidecar alias
   (`http://automata-egress-proxy:3128`) and `NO_PROXY=127.0.0.1,localhost`.

Unlike the worker plane's cooperative env proxying, env-unset does NOT bypass
this: the internal network has no route out except the sidecar. Teardown
(`shutdown`) removes sidecar + network; the test-container sweep also prunes
leaked `automata-egress-*` networks.

The proxy's matcher mirrors `packages/worker/src/agent-run/egress-proxy.ts`
(one matcher source per package — keep them in sync). Build artifact:
`pnpm -C packages/sandbox build-egress-proxy` regenerates
`dist/egress-proxy-standalone.cjs` **and** the embedded string module
`src/egress-proxy-standalone.generated.ts` (a vitest test fails if they drift).

**Audit (v1 limitation):** the sidecar logs every allow/deny decision as a JSON
line on its stdout — read with `docker logs <container-name>-egress`. It does
NOT post `egress_events` rows to the control plane yet; sandbox-plane audit
POSTs are a follow-up. The worker plane audits fully.

**Not covered:** Docker "Sandboxes"/`sbx`-style nested runtimes — future work.

## E2B — native firewall (SDK v2)

`Sandbox.create` passes `network: { denyOut: ["0.0.0.0/0"], allowOut: [...] }`
(mapper: `toE2bNetwork`). Enforced below the process — un-bypassable by
env-unset. Caveats:

- **OPS GATE — template rebuild required BEFORE this SDK bump reaches prod:**
  e2b v2's secure-by-default requires E2B templates rebuilt with **envd ≥
  0.2.0** (`pnpm -C packages/sandbox-image create-template:e2b:small` /
  `:large` against the new toolchain). Old-envd templates will fail against
  the v2 SDK. This cannot be verified in CI — it is a manual pre-deploy step.
- The SDK bump (1.2.0-beta.4 → ^2.7.1) replaced the patched `autoPause` with
  the stable `lifecycle: { onTimeout: "pause" }`; `patches/e2b.patch` is gone.
  `Sandbox.resume` is gone — `Sandbox.connect` auto-resumes.
- E2B selectors carry no port syntax: a `host:port` allowlist entry maps to
  its bare host at this plane. Domain filtering matches ports 80/443 only
  (Host/SNI); other ports fall through to the deny-all. UDP/QUIC bypasses
  domain matching — blocked by the deny-all unless the IP is allowlisted.
- Blocked TCP connects can APPEAR to succeed (connect() completes, traffic is
  dropped): verify enforcement by application-level failure, never by
  connect() alone.
- **Audit limitation:** E2B's firewall exposes no per-connection log we can
  consume — enforcement without per-connection `egress_events` rows on this
  plane (documented AC deviation on #66; needs owner sign-off).

## Daytona — create-time allowlists (SDK 0.205.1)

`daytona.create` receives (mapper: `toDaytonaNetwork`):

- `domain` → `domainAllowList` (comma-separated, `*.` wildcards, max 20 —
  more is an error),
- `ip_port` → **create-time error**: Daytona's `networkAllowList`
  (CIDR-only) and `domainAllowList` are **mutually exclusive at creation**
  (provider spike on #66), so a CIDR list cannot also carry the hostname
  system entries (daemon callback, github.com, api.github.com,
  api.anthropic.com) the control plane merges in at every level. Dropping
  them would sever the daemon callback and violate the shape's CONTRACT
  NOTE ("never drop"); resolving them to IPs control-plane-side is not
  acceptable either — GitHub/Anthropic IPs rotate, and a stale pin bricks
  runs silently. **Daytona supports `domain` level only in v1**; repos
  needing `ip_port` must use another provider.
- `none` → **create-time error**: `networkBlockAll` alone would sever the
  daemon callback; we refuse to create a broken sandbox. Repos that need
  `none` cannot run on Daytona until Daytona grows CIDR-exceptioned
  block-all.

Caveats:

- **OPS GATE — org tier:** Daytona organizations at tier 1/2 cannot override
  network settings; the create params are rejected or ignored. Verify on the
  real org (create a sandbox with `domainAllowList` set and probe it) BEFORE
  enabling egress policies on Daytona-provider repos.
- Create-time only: live network updates are tier-gated; acceptable since
  sandboxes are created per-thread.
- SDK bump 0.115.2 → 0.205.1 (root `pnpm.overrides` moved in lockstep; npm
  dual-publishes with the `@daytona/sdk` rename — same API, we keep the
  `@daytonaio/sdk` import name).
- **Audit limitation:** same as E2B — provider-side enforcement, no
  per-connection event feed; no `egress_events` rows from this plane.

## Verification matrix (manual, per provider)

With a repo policy `domain: ["github.com"]`:

1. in-sandbox `git ls-remote https://github.com/octocat/Hello-World.git HEAD`
   succeeds;
2. in-sandbox `git ls-remote https://gitlab.com/gitlab-org/gitlab.git HEAD`
   fails at application level;
3. daemon still reports status (callback host is a system entry);
4. Docker only: `docker logs <name>-egress` shows the allow + deny lines.

Opt-in automated check (needs a docker daemon):
`SANDBOX_PROVIDER=docker pnpm -C packages/sandbox vitest run docker-egress.integration`.
