# Credential brokering on managed sandbox providers (E2B, Daytona) — research spike

**Issue:** be-automata/automata #114 (managed-provider follow-up to the Docker
credential broker landed in #117).
**Status:** research spike — read-only; no product code changed.
**Date:** 2026-08-23.

## Question

The Docker plane solved credential custody with an **out-of-guest broker**: a
per-run sidecar container on a host-controlled `--internal` network holds the
GitHub installation token in its own container (read from a `0o400` `:ro`
mount, never argv/`-e`), and the guest reaches it by DNS alias carrying only a
per-run bearer (`packages/sandbox/src/providers/docker-cred-broker.ts`). The
guest never holds the installation token; guest-root cannot read it from
`/proc/<pid>/environ`.

E2B and Daytona are **managed** runtimes. #114 recorded them as blocked: _"no
host-reachable per-run peer."_ This spike determines definitively whether that
is true, and — more importantly — whether it matters.

## TL;DR verdict

| Provider    | Verdict                                                        | Primitive                                                                                                                                                          |
| ----------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **E2B**     | **TRACTABLE-NOW** (provider-native, no sidecar, no WAN broker) | `network.rules` per-host `transform.headers` egress injection (public beta) + `Secret` vault / `iam` workload identity (GA); `egressProxy` SOCKS5 (GA) as fallback |
| **Daytona** | **TRACTABLE-NOW** (provider-native, no sidecar, no WAN broker) | Organization `Secrets` — opaque `dtn_secret_<id>` placeholder substituted into HTTPS request headers at the outbound proxy, for allowlisted hosts only (GA)        |

**The "no host-reachable per-run peer" premise is literally TRUE but MOOT for
both providers.** Neither exposes a sidecar / second container / cloud-metadata
IP / port-forward-to-a-host-process that the guest could curl (their `getHost`
/ `getPreviewLink` are _ingress_ — they publish a guest port outward, not a
host peer inward). But **neither needs one**: both providers have shipped a
credential-injection primitive **in their own egress plane**, which performs
exactly the out-of-guest secret injection the Docker sidecar was built to do —
and does it _without the token ever entering any container we run_. This is a
**stronger** custody model than the Docker sidecar, not a weaker one.

This flips #114's premise for both managed providers. No WAN broker and no
short-TTL-token workaround are required — those remain viable fallbacks and are
assessed in §5–§6.

---

## 1. Codebase capability (what surfaces exist today)

Read: `packages/sandbox/src/providers/e2b-provider.ts`,
`providers/daytona-provider.ts`, `packages/sandbox/src/egress.ts`,
`packages/sandbox/src/types.ts`,
`docs/egress-enforcement.md`, plus the Docker reference
(`providers/docker-cred-broker.ts`, `providers/docker-egress.ts`).

### What the providers currently use

Both providers today use only **guest command/file APIs** plus a **create-time
network firewall**:

- **E2B** (`e2b-provider.ts:53-70`): `Sandbox.create(templateId, { network: toE2bNetwork(policy), envs, lifecycle })`. The only host-side surface consumed is `network: { denyOut, allowOut }` (`egress.ts:91-103`). Guest I/O is `sandbox.commands.run` / `sandbox.files.*`.
- **Daytona** (`daytona-provider.ts:70-78`): `daytona.create({ snapshot, envVars, domainAllowList, ... })`. Host-side surface consumed is `domainAllowList` only (`egress.ts:130-167`; `ip_port`/`none` throw). Guest I/O is `sandbox.process.*` / `sandbox.fs.*`.

Secrets today reach the guest as **plaintext env vars**. The raw
`githubAccessToken` becomes `env.GH_TOKEN` inside `getEnv()`
(`packages/sandbox/src/env.ts:32`), which is threaded as the `env:` of the
guest `runCommand` calls at **daemon start** (`daemon.ts:53`, `startDaemon`) and
**setup-script run** (`setup.ts:511`, `executeSetupScriptCommand`) — i.e. at
daemon/setup time, not at `Sandbox.create()`/`daytona.create()` (the providers
themselves never reference `githubAccessToken` — grep-verified zero matches in
`e2b-provider.ts`/`daytona-provider.ts`; their create-time `envs`/`envVars` only
carry user-supplied `options.environmentVariables`). That is precisely the
residency #114 wants to eliminate: guest-root can read `GH_TOKEN` from `/proc`.

### What the codebase already knows about the shape of the fix

`types.ts:19-45` (`CredentialBrokerShape`) and its HONESTY NOTE already frame
custody as _"a provider that consumes it becomes a secret custodian for the
run's lifetime."_ The Docker implementation makes **our sidecar** that
custodian. The finding below is that **E2B and Daytona can be the custodian
instead** — via primitives that did not exist (or that #66's spike did not
surface) when the "blocked" note was written.

The egress mappers (`egress.ts`) and `docs/egress-enforcement.md` also record
the SDK versions in play — `@e2b/code-interpreter@^2.7.1`,
`@daytonaio/sdk@0.205.1` — which is what makes the SDK capabilities in §2
available on the **currently declared dependency ranges** (verified in §2).

---

## 2. SDK / API capability (evidence)

Evidence is taken from the **installed SDK type definitions** in the repo's
pnpm store (the versions the codebase pins/resolves), corroborated with the
providers' official docs.

### 2.1 E2B — `@e2b/code-interpreter@2.7.1` → `e2b@^2.39.0` (resolved `e2b@2.45.0`)

`@e2b/code-interpreter@2.7.1/dist/index.d.ts` is `export * from 'e2b'` with
dependency `"e2b": "^2.39.0"`; the resolved core is `e2b@2.45.0`. So every type
below is reachable from the pinned wrapper.
Type source: `.../e2b@2.45.0/node_modules/e2b/dist/index.d.ts`.

**(a) Per-host egress header injection — `network.rules[host].transform.headers`.**
This is the headline finding. `SandboxOpts.network.rules` maps a host to
ordered transform rules; the egress proxy injects the resulting headers into
matching HTTP/HTTPS egress requests **on E2B's infrastructure, outside the
guest**:

```ts
// e2b@2.45.0 index.d.ts (SandboxNetworkOpts.rules docstring)
await Sandbox.create({
  network: {
    allowOut: ({ rules }) => [...rules.keys()],
    rules: {
      "api.openai.com": [
        { transform: { headers: { Authorization: `Bearer ${token}` } } },
      ],
    },
  },
});
```

Docstrings (verbatim): _"Per-domain transform rules applied to matching egress
HTTP/HTTPS requests."_ — _"HTTP headers to inject or override in matching
requests. An existing header with the same name is replaced. Values are plain
strings; secret resolution happens client-side before sending to the API."_
Official docs (`docs.e2b.dev/sandbox/internet-access`): _"The `transform.headers`
object is sent on the wire as-is and injected by the egress proxy on matching
HTTP/HTTPS requests."_ Status per the docs page: **public beta** — _"Per-host
request transforms are currently in public beta. You can start using them right
away, no need to request access."_ (A stale search snippet said "private beta,
email support@e2b.dev"; the canonical docs page says public beta. Treat access
as a thing to confirm with E2B before prod either way — see §7.) There is also
an open upstream tracking issue, e2b-dev/E2B #1160 "Credential/Secret Brokering
for HTTP(S) Requests".

This **is** an out-of-guest credential broker: the guest does plain
`git ... https://github.com/owner/repo`, the guest carries **no** token, and
E2B's egress proxy adds the `Authorization` header on the way to github.com.

**(b) Secrets vault — `Secret.create` / `Secret.fill` (GA).** A project-scoped
vault whose value is _"Write-only — never returned by the API."_ `Secret.fill(name)`
returns a placeholder string `'${e2b.secrets.<name>}'` that _"the runtime
resolves to the secret's value"_ server-side. Combined with (a), the token
never appears in the create payload the SDK sends **as a value** — only the
placeholder does. (Type: `declare class Secret extends ClientFactory` with
`static create/update/fill/iamToken/...`.)

**(c) Workload identity / IAM — `iam.tokens` + `Secret.iamToken` (GA for
create).** `SandboxOpts.iam.tokens` registers named `JWT-SVID` workload tokens;
a rule transform references them as `iam.tokens.<name>` placeholders that
_"the egress proxy replaces with a freshly minted token when it forwards the
request"_ — _"the secret itself never leaves the platform."_ This is the
first-class, per-request-minted version of (a); most relevant for cloud-IdP
federation (SPIFFE/STS), less so for a static GitHub installation token, but it
confirms the injection plane is a supported product surface, not a hack.

**(d) BYO egress proxy — `network.egressProxy` (SOCKS5, GA on E2B Cloud /
BYOC).** _"Tunnel the sandbox's outbound TCP through a SOCKS5 proxy you
operate… Tunneling happens on the host, after allowOut/denyOut filtering, so
nothing runs inside the sandbox and code running there can neither see the proxy
nor route around it."_ This is the _"force outbound through a broker host we
operate"_ primitive. Caveat: _"a sandbox that names a proxy on a deployment
built from the open source `e2b-dev/infra` repository is rejected as
unsupported"_ — Cloud/BYOC only.

**(e) Live update — `updateNetwork` / `SandboxNetworkUpdateConfig`.** Egress
rules (incl. transforms) can be replaced on a running sandbox without restart —
useful for rotating an injected credential mid-run (see token-TTL note, §7).

**(f) No in-network host peer.** `getHost(port)` returns a **public** URL for a
port _inside_ the sandbox (ingress, auth-gated by `allowPublicTraffic`). There
is no API for a second container, no cloud-metadata IP, and no
port-forward-to-a-host-process. So the literal "no host-reachable per-run peer"
is **true** — and irrelevant given (a)–(d).

### 2.2 Daytona — `@daytonaio/sdk@0.205.1`

Type source: `.../@daytonaio+sdk@0.205.1/node_modules/@daytonaio/sdk/cjs/Secret.d.ts`,
`Daytona.d.ts`, `Sandbox.d.ts`.

**(a) Organization Secrets with egress-layer substitution (GA).** The exact
Daytona analogue of E2B (a)+(b), and the decisive finding for Daytona.
`Secret.d.ts` (verbatim): _"The plaintext `value` is write-only and is never
returned by the API. When a Secret is referenced from a Sandbox, the injected
environment variable holds the opaque `Secret.placeholder` token, not the real
value. The real value is substituted transparently on outbound requests to the
Secret's allowed `hosts`."_ The placeholder is `dtn_secret_<id>`.

Create-time wiring (`Daytona.d.ts` `CreateSandboxBaseParams.secrets`,
verbatim): _"Optional map of environment variable name to the name of an
existing organization Secret to mount into the Sandbox. The env var is set to
the Secret's opaque placeholder; the real value is substituted transparently on
outbound requests to the Secret's allowed hosts."_ `CreateSecretParams.hosts`:
per-host allowlist (`api.example.com` or `*.example.com`; no ports).

Official docs (`daytona.io/docs/en/secrets/`, verbatim): _"A secret never
enters the sandbox in plaintext… an outbound proxy to swap the placeholder for
the real value at request time."_ — _"The proxy substitutes placeholders in
HTTPS request headers only."_ (plain HTTP, bodies, query params, and
transformed/base64 variants are **not** substituted). Plus **response
scrubbing**: _"rewrites real values back to placeholders in responses,
preventing plaintext exposure."_

So guest-root reading `/proc/<pid>/environ` sees only `dtn_secret_<id>` — inert
off-box and un-resolvable on-box. That satisfies #114's threat model even
though the mechanism is an env var (the env var is _not_ the secret).

**(b) `outboundProxyUrl` create param (convenience, NOT a boundary).**
`Daytona.d.ts` (verbatim): _"Outbound proxy URL to route the Sandbox HTTP(S)
traffic through. Applied via the HTTP(S)\_PROXY environment variables
(convenience routing, not a security boundary on its own); combine with
domainAllowList for unbypassable network-layer enforcement."_ Because it is
env-based, guest-root can unset it — so it is **not** a substitute for a broker
on its own. It is a route-through-our-host option, weaker than E2B's host-side
`egressProxy`.

**(c) No in-network host peer.** `Sandbox.getPreviewLink(port)` →
`PortPreviewUrl { url, token }` and `downloadUrl/uploadUrl` are **ingress /
pre-signed** surfaces (expose a guest port or file outward). No second
container, no metadata IP, no inbound host peer. Same conclusion as E2B (f):
literally true, practically moot.

---

## 3. How the fix maps onto each provider (design sketch — spec, do not build)

Both designs replace _"put the installation token in the guest env"_ with
_"put a placeholder in the guest and let the provider inject the real token at
egress."_ Git over HTTPS to github.com already sends an `Authorization` header,
which is exactly what both egress planes rewrite.

### 3.1 E2B design (preferred: Secret + rule, so the token is off the API too)

At create, control-plane-side:

1. `Secret.create('gh-inst-<runId>', <installationToken>, /* project-scoped */)`
   → value is write-only.
2. `Sandbox.create(templateId, { network: { allowOut: [...system hosts..., 'github.com'], rules: { 'github.com': [{ transform: { headers: { Authorization: 'Basic ' + base64('x-access-token:' + Secret.fill('gh-inst-<runId>')) } } }] } } })`.
   - Use `Secret.fill(...)` (placeholder), **not** the raw token string, so the
     value is never in the create payload nor readable via the sandbox-info
     endpoint (see §4). GitHub git-smart-HTTP accepts basic auth with username
     `x-access-token` and the installation token as password; `Authorization: token <token>`/`Bearer <token>` also work for API calls.
3. Guest git is configured with **no** credential (plain
   `https://github.com/owner/repo`). The guest holds nothing.
4. Teardown: `Secret.destroy(...)`. For runs >1h, rotate via `Secret.update` +
   `updateNetwork` (installation tokens expire hourly).

Fallback if header transforms are unavailable on our E2B plan: `egressProxy`
(SOCKS5) to a broker **we** operate that injects the header — reuses the
worker-plane broker logic, but now E2B pins the guest to it host-side
(un-bypassable), so it is a genuine boundary unlike Daytona's `outboundProxyUrl`.

### 3.2 Daytona design (native Secrets)

At create, control-plane-side:

1. `daytona.secret.create({ name: 'gh-inst-<runId>', value: <installationToken>, hosts: ['github.com'] })`.
2. `daytona.create({ snapshot, secrets: { GH_TOKEN_PLACEHOLDER: 'gh-inst-<runId>' }, domainAllowList: '...github.com,...' })`.
   The guest env `GH_TOKEN_PLACEHOLDER` = `dtn_secret_<id>` (inert).
3. Guest git is wired to send the **placeholder** in the `Authorization` header
   over HTTPS — e.g. `git config --global http.https://github.com/.extraheader "Authorization: Basic $(printf 'x-access-token:%s' "$GH_TOKEN_PLACEHOLDER" | base64)"`. **Caveat:** Daytona substitutes the placeholder only if it appears **literally** in an HTTPS request header; base64-wrapping the placeholder defeats substitution (docs: "transformed placeholders … are not substituted"). So the placeholder must land in the header **verbatim** — use `Authorization: token dtn_secret_<id>` (GitHub accepts `token <installation-token>` for git HTTPS and API), not a base64 basic-auth wrapper. This is the one real design constraint to validate on a live Daytona org.
4. Teardown: `daytona.secret.delete(...)`.

---

## 4. Security assessment

**Custody moves from guest `/proc` to the provider's egress plane.** In both
designs the installation token is never in the guest, never on guest argv/env
as a value, and never readable from `/proc`. That is the #114 goal, achieved
without a broker container of ours.

Residual custody surfaces, and how each design closes them:

- **Provider API read-back (E2B).** If the token were inlined as a _raw static
  header string_, the sandbox-info endpoint (`SandboxNetworkRuleInfo.transform.headers`)
  could return it to any holder of the E2B API key. **Mitigation:** use
  `Secret.fill()` (write-only vault) so only the placeholder is ever stored/returned.
  Daytona already guarantees this (value _"never returned by the API"_).
- **Provider trust.** Both models make the provider a plaintext custodian at
  egress (it must see the token to inject it). This is the same trust already
  extended to the provider for the guest filesystem and to E2B's SOCKS5 tunnel /
  domain MITM. Acceptable and explicitly in-scope per the `CredentialBrokerShape`
  HONESTY NOTE. Document it as an ADR deviation like the egress audit gap.
- **Host allowlist scoping.** Both let you bind the secret to `github.com`
  only, so an SSRF/exfil attempt to `evil.com` carries only the inert
  placeholder (Daytona: _"a request to any other host carries the unmodified
  placeholder"_; E2B: a rule fires only for its registered host). Strictly
  better than today's plaintext-env approach, where a leaked env reaches anywhere.
- **Response scrubbing (Daytona).** Bonus: real values are rewritten back to
  placeholders in responses, so a reflecting endpoint cannot echo the token
  into guest-visible output. E2B has no documented equivalent — the injected
  header is request-only, which is fine for git.
- **HTTPS-only / header-only.** Both substitute only HTTPS **request headers**
  (not bodies, query params, plain HTTP). Git smart-HTTP over 443 uses a header,
  so git is covered. Anything needing the token in a URL or body is not — not a
  concern for the git/GitHub-API use case.

**No new bearer-over-WAN exposure.** Unlike the WAN-broker alternative (§5),
these designs introduce **no** guest-held bearer at all — there is nothing in
the guest to replay or leak. That is their key advantage over §5.

---

## 5. Alternative (a): control-plane-hosted WAN broker

Guest reaches a control-plane broker over the public internet (through the
egress allowlist), presenting a per-run bearer over TLS; broker injects the
real credential and streams to github.com. **Viable but strictly worse than
§3** now that native injection exists:

- **Bearer exposure/replay:** re-introduces exactly the guest-held secret #114
  removes — the per-run bearer sits in the guest and is readable from `/proc`.
  It is useless _off-box_ only if the broker pins it to the run's source
  identity, which is hard over WAN (NAT'd egress IPs). Native injection has
  **no** guest-held secret.
- **Availability/latency:** adds a control-plane dependency on every git
  operation across the public internet; native injection is in-path on the
  provider's own proxy.
- **When it still matters:** only if a provider lacks native injection (neither
  does) or if we deliberately want a single audited choke point. Keep as a
  documented fallback, not the plan.

## 6. Alternative (b): short-TTL scoped tokens (no broker at all)

Mint a **tightly scoped, short-TTL** GitHub token per operation
(fine-grained/installation token scoped to the single repo, minimal
permissions, ~≤1h) and hand it to the guest directly. This **sidesteps the
broker** by making the guest-resident secret low-value:

- **Pros:** simplest; no provider secret feature required; works identically on
  every provider incl. today's plaintext-env path. Installation tokens are
  already repo-scoped and 1h-lived, so much of this exists.
- **Cons:** the token is still guest-readable for its TTL — a compromised guest
  can exfiltrate and use it against the one repo until expiry. That is a real
  residual the broker/native-injection models eliminate entirely.
- **Verdict:** a legitimate **defense-in-depth complement** (scope/TTL should be
  tightened regardless), but not a full substitute for keeping the token out of
  the guest. Best combined with §3: mint short-TTL **and** inject at egress.

## 6.1 Provider-native secret mechanisms

Covered in §2: **E2B `Secret` + `iam`** and **Daytona organization `Secrets`**
are exactly this, and they are the recommended path (§3).

---

## 7. Per-provider verdict

### E2B — **TRACTABLE-NOW**

Primitive: **`network.rules[host].transform.headers`** (egress header
injection, public beta) with the token supplied via **`Secret.fill()`** (GA
vault, write-only). The guest holds no credential; E2B's egress proxy injects
`Authorization` on requests to github.com only. `egressProxy` (SOCKS5, GA on
Cloud/BYOC) is a full-boundary fallback; `iam`/JWT-SVID is the per-request-minted
variant for cloud IdPs. **Superior to the Docker sidecar** — the token never
enters any container we run.

Gates before prod (ops, not code):

- Confirm per-host **transform availability on our E2B plan** (docs say public
  beta / no access request; a stale snippet said email support@e2b.dev — verify).
- `egressProxy` requires **E2B Cloud or BYOC** (rejected on open-source
  `e2b-dev/infra` deployments).
- **Token TTL:** installation tokens expire hourly — rotate via
  `Secret.update` + `updateNetwork`, or re-create per operation.
- Verify GitHub git-smart-HTTP accepts the chosen header form
  (`Basic x-access-token:<tok>` vs `token <tok>`) with an injected-only header
  (no guest fallback credential).

### Daytona — **TRACTABLE-NOW**

Primitive: **organization `Secrets`** — `secret.create({ value, hosts:['github.com'] })`

- `create({ secrets: { ENV: 'name' } })`. Guest env holds only
  `dtn_secret_<id>`; Daytona's outbound proxy substitutes the real token into the
  HTTPS `Authorization` header for allowlisted hosts, and scrubs it from
  responses. GA and documented. `outboundProxyUrl` exists but is env-based
  (convenience, not a boundary).

Gates before prod (ops, not code):

- **Org tier:** the existing egress note already flags that tier-1/2 Daytona
  orgs cannot override network settings — verify Secrets + host allowlist work
  on our org tier (create a secret, mount it, probe substitution) before enabling.
- **Verbatim-placeholder constraint (§3.2 step 3):** the placeholder must reach
  the header **un-transformed** — use `Authorization: token dtn_secret_<id>`,
  never a base64 basic-auth wrapper (base64 defeats substitution). Validate live.
- HTTPS-request-header-only: fine for git; note the limitation for any future
  non-header credential use.

### What would have kept them BLOCKED (and no longer does)

Had neither provider shipped egress-layer secret injection, the fallback ladder
would be: **§6 short-TTL scoped tokens** (works everywhere, weaker) →
**§5 WAN broker** (reintroduces a guest-held bearer) → file a provider feature
request for header injection. That request has effectively already been granted:
E2B `network.rules` transforms (public beta; tracking issue e2b-dev/E2B #1160)
and Daytona `Secrets` (GA).

---

## 8. Recommendation

Both managed providers are **unblocked**. Recommend a follow-up implementation
issue that, behind the existing `credentialBroker` flag, adds a
provider-native brokering path parallel to the Docker sidecar:

- **E2B:** `Secret.fill()` + `network.rules` github.com header injection
  (fallback: `egressProxy` SOCKS5 to our injector).
- **Daytona:** organization `Secrets` with `hosts: ['github.com']` and a
  verbatim-placeholder `Authorization` header.

Do the two ops validations first (E2B transform-plan access; Daytona org-tier +
verbatim-placeholder probe). Record the "provider is plaintext custodian at
egress" trust statement as an ADR deviation, mirroring the egress-audit gap
already documented in `docs/egress-enforcement.md`.

---

## Appendix — evidence index

- Codebase: `packages/sandbox/src/providers/e2b-provider.ts`,
  `providers/daytona-provider.ts`, `packages/sandbox/src/egress.ts`,
  `packages/sandbox/src/types.ts`
  (`CredentialBrokerShape`), `providers/docker-cred-broker.ts` (reference),
  `docs/egress-enforcement.md`.
- E2B SDK types: `@e2b/code-interpreter@2.7.1` (`export * from 'e2b'`,
  dep `e2b@^2.39.0`; resolved `e2b@2.45.0`) —
  `SandboxNetworkOpts.rules`/`transform`, `SandboxNetworkTransformContext`,
  `SandboxIamOpts`, `SandboxEgressProxyOpts`, `class Secret`
  (`create`/`fill`/`iamToken`), `updateNetwork`/`SandboxNetworkUpdateConfig`,
  `getHost`.
- Daytona SDK types: `@daytonaio/sdk@0.205.1` — `Secret.d.ts`
  (`SecretService`, `CreateSecretParams.hosts`, placeholder `dtn_secret_<id>`),
  `Daytona.d.ts` (`CreateSandboxBaseParams.secrets` / `outboundProxyUrl` /
  `domainAllowList`), `Sandbox.d.ts` (`getPreviewLink`, `downloadUrl`).
- Official docs: `docs.e2b.dev/sandbox/internet-access` (transforms public
  beta; egress proxy injects headers), e2b-dev/E2B issue #1160;
  `daytona.io/docs/en/secrets/` (write-only value, HTTPS-request-header-only
  substitution, host allowlist, response scrubbing).
  </content>
