# Credential brokering — decision record (#114)

**Status:** decided — consolidates and reconciles the two #114 research docs into
one recommendation.
**Date:** 2026-08-23.
**Supersedes:** Decision 2 ("managed planes") of
[`credential-brokering-industry-benchmark.md`](./credential-brokering-industry-benchmark.md).

This record reconciles the two research artifacts produced for #114:

- **The spike** —
  [`credential-brokering-managed-providers-spike.md`](./credential-brokering-managed-providers-spike.md)
  — read-only investigation of the managed providers, grounded in the installed
  SDK type definitions plus provider docs. Finding: **E2B and Daytona both ship a
  native, never-resident credential-injection primitive** — E2B
  `network.rules[host].transform.headers` (public beta) supplied via
  `Secret.fill()` (GA, write-only vault); Daytona organization `Secrets` with
  `hosts:['github.com']` and `dtn_secret_<id>` placeholder substituted into the
  outbound HTTPS `Authorization` header at the provider's egress proxy (GA).
  Verdict: both **TRACTABLE-NOW** via provider-native injection — a _stronger_
  custody model than our Docker sidecar, because the token never enters any
  container we run.
- **The benchmark** —
  [`credential-brokering-industry-benchmark.md`](./credential-brokering-industry-benchmark.md)
  — surveys what enterprise products actually ship, and decides two questions.
  Decision 1 (the `gh`/`api.github.com` half): a **CA-terminating CONNECT proxy**
  in the existing per-run Docker sidecar (Cloudflare Outbound Workers / Anthropic
  `sandbox-runtime` / Docker `sbx` pattern). Decision 2 (managed planes):
  recommended "accept a short-TTL resident token" — the Vercel/Codespaces/Actions
  pattern.

## The reconciled decision (one paragraph)

For #114, keep never-resident credential custody on **every** plane where it is
reachable. On the **Docker plane**, extend the existing per-run sidecar into a
**CA-terminating CONNECT proxy** for the `gh`/`api.github.com` half — a per-run
ephemeral CA whose private key never leaves the sidecar, fail-closed on injection
failure, with a repo-scoped installation token (Decision 1 of the benchmark,
unchanged; both docs agree). On the **managed planes**, use each provider's
**native, never-resident egress-layer injection** as the primary path — **E2B**
`network.rules['github.com'].transform.headers` with the token supplied via
`Secret.fill()` (never the raw string), and **Daytona** organization `Secrets`
(`hosts:['github.com']`) with the `dtn_secret_<id>` placeholder sent verbatim in
the `Authorization` header — so the installation token is never resident in the
guest on any plane. **Short-TTL, single-repo, fine-grained/installation tokens
remain a documented defense-in-depth measure** (tighten scope/TTL regardless) and
the **fallback** for any repo, org tier, or provider plan that cannot reach the
native injection primitive; they are no longer the recommendation for the managed
planes.

## The one conflict, and how it was resolved

The two docs give **contradictory** answers for the managed planes:

|                       | Managed-plane recommendation                       | Basis                                                                                                                                                  |
| --------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Benchmark, Decision 2 | Accept a **short-TTL resident token** in the guest | _Assumed_ E2B/Daytona expose **no** host-controlled way to keep the credential out of the guest ("no in-network peer, secrets are plaintext env vars") |
| Spike                 | Use **provider-native never-resident injection**   | _Found_ both providers ship an egress-layer injection primitive that keeps the token out of the guest entirely                                         |

**Resolution: the spike wins.** The benchmark's Decision 2 rests on a factual
premise — "there is no never-resident option on E2B/Daytona" — that the spike
disproved with direct evidence from the installed SDK types and the providers'
own docs. This is not a judgement-call tie between two valid strategies; it is one
doc lacking a capability the other doc located. Where the benchmark reasoned "no
peer ⇒ must accept residency," the correct reading is "the provider _is_ the peer
— it injects at its own egress plane." The benchmark's Decision 2 is therefore
marked **SUPERSEDED** in place (a banner now points here), its short-TTL-token
recommendation demoted to the fallback tier. Decision 1 (the Docker `gh`-API
CA-proxy) is untouched — both docs agree on it, and the spike's finding does not
bear on the Docker plane.

### Evidence check (spike claims verified before enshrining)

The spike's SDK-type claims were re-verified against the installed type
definitions in this repo's pnpm store before writing this record:

- **E2B** — `e2b@2.45.0` (resolved from the pinned `@e2b/code-interpreter@2.7.1`
  → `e2b@^2.39.0`), `dist/index.d.ts`:
  - `SandboxNetworkOpts.rules` / `SandboxNetworkRule.transform.headers` present,
    with the verbatim docstring _"Per-domain transform rules applied to matching
    egress HTTP/HTTPS requests"_ and _"HTTP headers to inject or override in
    matching requests … secret resolution happens client-side before sending to
    the API."_
  - `class Secret` documented _"write-only: … accepted by `Secret.create` /
    `Secret.update` but never returned by any read surface"_, with
    `static fill(secret: string): string` returning the resolver placeholder.
  - `iam.tokens` / `Secret.iamToken` and `egressProxy` (SOCKS5) present as the
    spike describes.
- **Daytona** — `@daytonaio/sdk@0.205.1`, `Secret.d.ts`: value _"write-only and
  … never returned by the API"_; opaque placeholder `dtn_secret_<id>`; per-host
  `hosts` allowlist; _"real value is substituted transparently on outbound
  requests to the Secret's allowed hosts."_ `Daytona.d.ts`
  `CreateSandboxBaseParams.secrets` maps an env-var name to an existing org
  Secret, mounting only the placeholder.

All load-bearing claims check out. The "public beta" status of E2B per-host
transforms and Daytona's org-tier/verbatim-placeholder constraints are the ops
gates below — capability-present in the SDK, access-to-confirm before prod.

## Per-item plan for #114

Implement behind the existing `credentialBroker` flag, adding a provider-native
brokering path parallel to the Docker sidecar. All three items preserve the
never-resident property; short-TTL tokens sit underneath as the fallback.

### 1. `gh` / `api.github.com` half → CA-terminating CONNECT proxy (Docker plane)

Extend the existing per-run Docker credential-broker sidecar to CA-terminate
`CONNECT api.github.com` and swap the per-run bearer for the installation token
server-side (covers arbitrary HTTPS clients — `gh`, Octokit, curl — that the
git-only `insteadOf` rewrite cannot). Unchanged from the benchmark's Decision 1;
both docs agree.

- **Non-negotiables:** per-run **ephemeral CA**, private key **never** enters the
  guest (mint leaf certs inside the sidecar only); **fail closed** (today's 401)
  if injection cannot happen; installation token scoped to the run's repo +
  minimal permissions so a proxy compromise stays bounded.

### 2. E2B → `transform.headers` + `Secret.fill()` (native, never-resident)

At create, control-plane-side: `Secret.create('gh-inst-<runId>', <token>)`
(write-only), then `Sandbox.create(templateId, { network: { allowOut: [...,
'github.com'], rules: { 'github.com': [{ transform: { headers: { Authorization:
<basic/token form using `Secret.fill('gh-inst-<runId>')`> } } }] } } })`. The
guest does plain `https://github.com/owner/repo` and holds no credential; E2B's
egress proxy injects the `Authorization` header on requests to github.com only.
Rotate via `Secret.update` + `updateNetwork` for runs past the ~1h installation-
token TTL; `Secret.destroy` on teardown. Fallback if header transforms are
unavailable on our plan: `egressProxy` (SOCKS5) to an injector we operate — a
genuine host-side boundary on E2B Cloud/BYOC.

- **Ops gate (not code):** confirm **per-host transform availability on our E2B
  plan** — docs say public beta / no access request, but a stale snippet said
  email support@e2b.dev, so verify before prod. `egressProxy` fallback requires
  E2B Cloud or BYOC (rejected on open-source `e2b-dev/infra` deployments).

### 3. Daytona → organization `Secrets` host-substitution (native, never-resident)

At create: `daytona.secret.create({ name: 'gh-inst-<runId>', value: <token>,
hosts: ['github.com'] })`, then `daytona.create({ snapshot, secrets: {
GH_TOKEN_PLACEHOLDER: 'gh-inst-<runId>' }, domainAllowList: '…github.com…' })`.
The guest env holds only `dtn_secret_<id>` (inert). Wire git to send the
placeholder **verbatim** in the HTTPS `Authorization` header — e.g.
`Authorization: token dtn_secret_<id>` (GitHub accepts `token <installation-
token>` for git HTTPS and the API). Daytona's outbound proxy substitutes the real
token for allowlisted hosts and scrubs it back out of responses.
`daytona.secret.delete` on teardown.

- **Ops gate (not code):** verify **org tier** — tier-1/2 orgs may not override
  network settings; create a secret, mount it, and **probe substitution** on our
  org before enabling. **Verbatim-placeholder constraint:** the placeholder must
  reach the header un-transformed — a base64 basic-auth wrapper defeats
  substitution, so use `Authorization: token dtn_secret_<id>`, not a wrapped
  form. Validate live.

### Fallback tier (all planes) → short-TTL scoped tokens

Where a repo, org tier, or provider plan cannot reach the native primitive above,
fall back to a per-run, **single-repo, fine-grained/installation token** with the
shortest workable TTL (~≤1h), minted via OIDC/App-key exchange (no static app
private key on the box), audited on mint, and **revoked on teardown**. This bounds
_scope and lifetime_ but not _residency_ — treat it as defense-in-depth, not a
substitute for keeping the token out of the guest, and combine it with native
injection where both are available.

## Trust note (record as ADR deviation)

Both managed-plane designs make the **provider a plaintext credential custodian at
its egress plane** (it must see the token to inject it) — the same trust already
extended to the provider for the guest filesystem and to E2B's SOCKS5 tunnel /
domain MITM, and explicitly in-scope per the `CredentialBrokerShape` HONESTY NOTE
in `packages/sandbox/src/types.ts`. Record it as an ADR deviation,
mirroring the egress-audit gap already documented in
`docs/egress-enforcement.md`.
