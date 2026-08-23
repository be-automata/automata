# Issue #114 — E2B native never-resident GitHub credential injection

**Status:** implemented behind the `sandboxCredentialBroker` flag (+
`SANDBOX_CREDENTIAL_BROKER=on` force-on); unit-tested; **live E2E is a gated ops
step** (E2B transform-plan access — see §7). Default OFF and fail-safe.
**Date:** 2026-08-23.
**Design basis:** `docs/credential-brokering-managed-providers-spike.md` §3.1 and
`docs/credential-brokering-decision.md` item 2. Verified against the installed
SDK types (`e2b@2.45.0`, resolved from `@e2b/code-interpreter@2.7.1`).

## 1. Mechanism — never-resident, provider-native

The GitHub installation token is **never resident in the guest** on the E2B
brokered path. Instead:

1. The token lives in E2B's **write-only Secret vault** (`Secret.create(name,
   token)` — the value is never returned by any read surface).
2. A per-host **egress transform rule** injects
   `Authorization: token ${e2b.secrets.<name>}` on outbound HTTPS requests to
   `github.com` **and** `api.github.com`. `Secret.fill(name)` returns the inert
   placeholder string `'${e2b.secrets.<name>}'`; E2B's egress proxy resolves it
   to the real token **per request, outside the guest**. The placeholder never
   carries the secret and header values **override** any header already present.
3. The guest holds only: a **non-secret placeholder** `GH_TOKEN`/`GITHUB_TOKEN`
   (`env.ts` → `E2B_BROKERED_GH_TOKEN_PLACEHOLDER`) so `gh`/Octokit still emit an
   `Authorization` header for E2B to override; and **no** `~/.git-credentials`
   (`setup.ts` E2B branch only defensively scrubs residue). Git uses plain
   `https://github.com/...` with no credential — the header is injected at egress.

One mechanism covers **both** git-over-HTTPS and the `gh`/`api.github.com` REST
API — no separate CA-terminating proxy is needed (that is the Docker plane's
concern).

`/proc/<pid>/environ`, guest argv, and guest disk never contain the installation
token; an SSRF/exfil to any other host carries only the inert placeholder (the
rule fires only for its registered host).

## 2. The E2B broker directive shape

`CredentialBrokerShape` is now a **discriminated union** on `kind`
(`packages/sandbox/src/types.ts`):

- `docker-sidecar` — `{ kind, installationToken, runBearer, repoFullName }`
  (unchanged Docker behavior).
- `e2b-native` — `{ kind, installationToken, repoFullName }`. **No** per-run
  bearer (there is no sidecar) and **no** secret name.

**Deviation (justified):** the design sketch put a "per-run secret name" in the
shape. Instead the vault-secret name is **derived deterministically from the E2B
sandboxId** — `e2bBrokerSecretName(sandboxId)` = `gh-inst-<sanitized-id>` — the
only handle that (a) survives pause/resume and (b) is available at
teardown-by-id. This lets **create, resume-refresh, and teardown** all address
the same vault entry with **no extra persistence** — resume relies solely on the
non-secret `credentialBrokerMode` provenance already on the thread, exactly as
the design requires. The token in the shape is used only to seed/refresh the
vault; it never reaches the guest.

## 3. Create flow (`e2b-provider.ts`, brokered)

The secret name derives from the sandboxId, which does not exist until create, so
the rules are attached in a second step:

1. Build the firewall **base** (`e2bBrokeredCreateBaseNetwork`) — the egress
   allow/deny lists **without** rules; ensures both GitHub hosts are in
   `allowOut` so the rules can fire.
2. `Sandbox.create(template, { network: base, ... })`.
3. `Secret.create(e2bBrokerSecretName(sandboxId), installationToken)`.
4. `sandbox.updateNetwork(toE2bBrokeredNetwork({ egressPolicy, authHeaderValue }))`
   where `authHeaderValue = \`token ${Secret.fill(name)}\``.

**Fail closed:** any failure in steps 3–4 destroys the secret and kills the fresh
guest before rethrowing — never a fall-back to a resident raw token. The guest
does no git before setup runs (which happens after `getOrCreateSandbox` returns),
so the create→updateNetwork window carries no risk.

## 4. allowOut composition (`egress.ts` → `toE2bBrokeredNetwork`)

Composes the broker rules with any per-repo egress policy (#66) **without
clobbering it**:

- **Egress policy present:** reuse `toE2bNetwork` for `denyOut: ["0.0.0.0/0"]` +
  the resolved allowlist, then **merge** `github.com`/`api.github.com` into
  `allowOut` (idempotent — never drops or duplicates a repo entry). Rules must
  reference hosts that also appear in `allowOut` (SDK contract).
- **No egress policy:** keep today's **open internet** —
  `allowOut: ["0.0.0.0/0", "github.com", "api.github.com"]` (the sentinel allows
  all; the explicit hosts satisfy the rule-host contract) and **no** `denyOut`
  (setting one would newly restrict egress the flag-off path never restricted).

The mapper is pure and free of the e2b SDK and of any secret material (it stores
only the caller-built placeholder header).

## 5. Resume flow — refresh in place (not recreate)

Unlike Docker (which is non-resumable and recreates), an E2B brokered sandbox
**resumes in place**: its egress rules and vault entry persist across pause. But
the installation token expires (~1h), so on resume the provider **refreshes** the
vault secret:

- Control plane (`resolveCredentialBrokerForResume`, gated on the **persisted**
  `credentialBrokerMode === "brokered"`, not the current flag) reconstructs an
  `e2b-native` shape with a **fresh** token and passes it on the resume options.
- Provider: `Secret.exists(name) ? Secret.update(name, freshToken) :
  Secret.create(name, freshToken)` **BEFORE** `Sandbox.connect`. `connect`
  auto-resumes the guest, so the refresh runs first (no live sandbox connection
  needed — the Secret is project-scoped and addressed by name) so the guest never
  resumes on the prior credential. On refresh failure the provider throws
  **without connecting**, leaving the sandbox paused. Rules reference the secret
  by name, so **no** `updateNetwork` is needed. After connect, a post-resume
  liveness probe runs; if it fails the guest is torn down (kill + secret destroy).
- `env.ts`/`setup.ts` take the E2B brokered branch on resume too (no resident raw
  token; scrub any `~/.git-credentials`).

**Fail closed:** if the refresh throws, or the provenance is `"brokered"` but no
shape is supplied, the resume throws rather than falling back to a resident raw
token. `apps/www/src/agent/sandbox.ts` routes only **Docker** brokered resumes to
the recreate path; E2B falls through to the in-place resume with the refresh
shape.

## 6. Teardown — no orphan secrets

- `E2BSession.shutdown()` (create/resume path) destroys the secret in a `finally`
  after `kill()`, so a rejected `kill()` cannot orphan it. Destroy is
  **retry-then-WARN**: on failure it retries once and, if still failing, logs a
  clear WARN naming the secret so an operator can reclaim it (never silently
  swallowed).
- `E2BProvider.shutdownById(sandboxId)` **kills FIRST, then destroys the secret in
  a `finally`.** `Sandbox.connect` auto-resumes the guest, so destroying the
  secret before connect would briefly resume the guest with its rules pointing at
  a now-deleted secret. Killing first means the guest only ever resumes while the
  secret still exists, and the `finally` still guarantees the secret is destroyed.
  Uses the same retry-then-WARN destroy. Reclaims the vault entry for teardown
  routes that rehydrate a bare session (e.g. `shutdownSandboxById`).

`Secret.destroy` of a missing secret is a no-op, so these are safe for
unbrokered E2B sandboxes too.

## 7. Ops gate — live E2E (NOT done here; requires E2B plan access)

`network.rules[host].transform.headers` is E2B **public beta** and requires
transform-plan access on the E2B team. `Secret.*` is GA. Live verification needs
an **E2B API key + the transform plan**, which is **not available in this
environment**. This change is therefore implemented + unit-tested + type-checked
only; it is **not claimed live-verified**. Mirrors the E2B template/plan gate
recorded in `docs/egress-enforcement.md`.

Before enabling in prod (ops, not code):

1. **Confirm per-host `transform.headers` is enabled on our E2B team/plan.** Docs
   say public beta / no access request, but confirm before flipping the flag.
2. **Live probe:** create a brokered E2B sandbox, run `git ls-remote
   https://github.com/<private-repo>` and `gh api repos/<owner>/<repo>` **with no
   guest credential**, and confirm both succeed via injected auth; confirm
   `/proc`, `git config --global -l`, and `~/.git-credentials` contain **no**
   installation token.
3. **Header form:** verify GitHub git-smart-HTTP + REST accept
   `Authorization: token <installation-token>` as the injected-only header (no
   guest fallback credential). (`token <tok>` works for both git HTTPS and the
   API; a `Basic x-access-token:<tok>` form is the alternative if needed.)
4. **Token TTL / rotation:** confirm resume refresh (`Secret.update`) rotates the
   vault value for runs past ~1h.
5. **Fallback:** if `transform.headers` is unavailable on our plan, the SDK also
   exposes `network.egressProxy` (SOCKS5, E2B Cloud/BYOC) to an injector we
   operate — a documented fallback, not implemented here.

### 7a. Secondary connect paths — freshness residual (documented, NOT fully fail-closed)

Two low-level provider paths call `Sandbox.connect` (which auto-resumes a paused
guest) with **no control-plane installation token**, so they **cannot refresh**
the vault secret and a brokered guest resumes on the already-vaulted token:

- `E2BProvider.extendLife(sandboxId)` — keepalive `setTimeout`.
- `E2BProvider.getSandboxOrNull(sandboxId)` — used by the admin daemon-log view
  (`apps/www/src/server-actions/admin/sandbox.ts`).

This is **NOT a leak** — never-resident holds: the token stays in E2B's egress
plane and never enters the guest env/argv/disk — and freshness is bounded by the
installation token's own **~1h TTL**. It is a **freshness / fail-closed gap**,
stated honestly here rather than papered over: these read-only/keepalive paths
resume a brokered sandbox **without rotation**. Full rotation-on-every-connect is
a **follow-up** requiring the control-plane token to be threaded through these
low-level paths (they currently take only a `sandboxId`). The primary
agent-work resume path (`resumeSandbox`) DOES refresh-before-connect and is
fail-closed; only these secondary paths carry the documented residual.

## 8. Trust note (ADR deviation)

On the E2B brokered path E2B becomes a **plaintext credential custodian at its
egress plane** (it must see the token to inject it) — the same trust already
extended for the guest filesystem and egress MITM, and explicitly in-scope per
the `CredentialBrokerShape` HONESTY NOTE. Record as an ADR deviation, mirroring
the egress-audit gap in `docs/egress-enforcement.md`.

## 9. Files changed

- `packages/sandbox/src/types.ts` — `CredentialBrokerShape` discriminated union
  (`docker-sidecar` | `e2b-native`).
- `packages/sandbox/src/egress.ts` — `toE2bBrokeredNetwork`,
  `E2B_BROKER_GITHUB_HOSTS`, structural rule types.
- `packages/sandbox/src/providers/e2b-provider.ts` — brokered create (vault +
  post-create rule attach), resume refresh, teardown, `shutdownById`,
  `e2bBrokerSecretName`.
- `packages/sandbox/src/env.ts` — E2B brokered branch (placeholder GH_TOKEN;
  `E2B_BROKERED_GH_TOKEN_PLACEHOLDER`).
- `packages/sandbox/src/setup.ts` — E2B brokered git-credentials branch (scrub;
  no `~/.git-credentials`).
- `packages/sandbox/src/providers/docker-provider.ts`,
  `providers/docker-cred-broker.ts` — narrow to the `docker-sidecar` variant.
- `apps/www/src/server-lib/credential-broker/resolve-credential-broker.ts` —
  E2B create directive + `resolveCredentialBrokerForResume`.
- `apps/www/src/agent/sandbox.ts` — E2B in-place brokered resume wiring; recreate
  gated to Docker.
- Tests: `egress.test.ts`, `env.test.ts`, `providers/e2b-provider.test.ts`,
  `setup.test.ts`, `resolve-credential-broker.test.ts`; Docker fixtures updated
  for the `kind` discriminant.
- Docs: `packages/sandbox/README.md`, `docs/credential-brokering-decision.md`.
</content>
</invoke>
