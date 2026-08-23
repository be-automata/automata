# Credential brokering — industry benchmark & decision memo (#114)

Grounds two open architectural decisions for the sandbox-plane credential broker
against what enterprise products actually ship. Not a survey of blog theory —
every row is a real product/repo we can point at.

**Scope.** The git half of the sandbox broker is done on the Docker plane (PR #117,
`SANDBOX_CREDENTIAL_BROKER=on`): a per-run credential-broker sidecar holds the
installation token in a `0o400 :ro` file, the guest gets only a per-run,
repo-fenced bearer, and git works via `insteadOf`+`Bearer` with the real token
injected server-side. No `~/.git-credentials` on the brokered path. Two things
are still open, and this memo decides them:

1. **The gh-API half** — the agent's `gh` / `api.github.com` calls. Today they
   fail closed (401) on a brokered guest. Should this be a **CA-terminating
   CONNECT proxy** (never-resident) or should we **pivot to short-TTL scoped
   tokens** (bounded residency)?
2. **Managed planes (E2B, Daytona)** — no host-controlled in-network peer, so the
   Docker sidecar pattern does not transfer. Do we build a never-resident broker,
   or accept a **short-TTL scoped token resident in the guest**?

---

## 1. The mechanism landscape (who actually ships what)

Two families of solution exist in production. The dividing line is **whether the
platform gives you a host-controlled peer on the sandbox's network path**.

### Family A — never-resident brokers (require a host-controlled in-network peer)

The real credential lives in a process the guest cannot read; the guest gets a
plain request path or a non-reusable token; the secret is attached out-of-band.
Three sub-variants by how the guest reaches the peer:

| Product                                                                                                                                                                     | Mechanism                                                                                                                                                                                                | Secret lives                              | Guest sees                                                  | TLS intercept?                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Cloudflare Sandboxes — Outbound Workers** ([blog](https://blog.cloudflare.com/sandbox-auth/), [docs](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/)) | Egress Worker on the same machine injects headers; **per-instance ephemeral CA** placed in the sandbox at `/etc/cloudflare/certs/…`, leaf certs minted per-SNI, CA **private key stays in the sidecar**  | Worker `env` binding, outside the sandbox | plain request; never the token                              | **Yes** — `interceptHttps=true` by default                                  |
| **Anthropic `sandbox-runtime`** ([repo](https://github.com/anthropic-experimental/sandbox-runtime))                                                                         | JWT-authenticated **TLS-terminating egress proxy**; "vault credential proxy" substitutes masked credentials into request bodies at the proxy                                                             | proxy process / vault                     | a JWT (org + allowed hosts), never the vault secret         | **Yes**                                                                     |
| **Docker Sandboxes (`sbx`)** ([docs](https://github.com/docker/docs/blob/main/content/manuals/ai/sandboxes/security/credentials.md))                                        | Host-side proxy intercepts outbound, injects credential by destination domain; secret in OS keychain                                                                                                     | OS keychain, host side                    | authenticated response; never the raw credential            | **Yes** (host-side intercept)                                               |
| **Modal — `credential-injection`** ([repo](https://github.com/modal-labs/credential-injection))                                                                             | **Sidecar reverse proxy** on a private network reachable only from the sandbox; strips `Authorization`, injects real key from a mounted Secret; empty `outbound_cidr_allowlist` cuts the public internet | Secret mounted on sidecar only            | plain **HTTP** to `http://egress-proxy:8080`; never the key | **No** — network isolation is the boundary; guest must target the proxy URL |
| **Automata Docker plane (today, #117)**                                                                                                                                     | `--internal` net + per-run sidecar; git via `insteadOf`+`Bearer`, token injected server-side; installation token in `0o400 :ro` file                                                                     | sidecar file, host side                   | per-run repo-fenced bearer                                  | **git: no** (smart-HTTP rewrite). **gh-API: not yet**                       |

Note the split within Family A: Cloudflare / Anthropic / Docker-sbx **TLS-intercept
with a guest-trusted CA** (works for _any_ HTTPS client, including `gh`, Octokit,
curl, unmodified). Modal and Automata's git half **avoid the CA** by making the
client target a proxy URL — which works for git (native `insteadOf` URL rewrite)
but **not** for arbitrary `api.github.com` HTTPS callers, who won't voluntarily
downgrade to a plain-HTTP loopback.

### Family B — bounded-residency short-TTL scoped tokens (no in-network peer needed)

The token _is_ handed to the guest, but minted per-run, tightly scoped, and
short-lived. This is what everyone without a host-controlled peer ships.

| Product                                                                                                                                                                       | Mechanism                                                                                                                                  | Residency bound                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| **GitHub Actions `GITHUB_TOKEN`** ([model](https://tenki.cloud/blog/github-actions-permissions-model))                                                                        | Per-**job** installation token minted before the job, dies at job end; permissions declarable per-job                                      | TTL = job lifetime (≤6h hosted); repo-scoped, per-permission     |
| **GitHub App installation tokens** ([create-github-app-token](https://github.com/actions/create-github-app-token))                                                            | Mint fresh per run with `permission-contents` / `permission-pull-requests`, single-repo scope                                              | **1 hour**, fine-grained scope                                   |
| **Fine-grained PATs** ([GitHub blog](https://github.blog/security/application-security/introducing-fine-grained-personal-access-tokens-for-github/))                          | Per-repo, per-permission, expiring                                                                                                         | user-set expiry, fine-grained                                    |
| **Vercel Sandbox** ([auth docs](https://vercel.com/docs/sandbox/concepts/authentication), [private-repo KB](https://vercel.com/kb/guide/sandbox-private-github-repositories)) | OIDC token for **Vercel** resources; for **private GitHub** you inject a GitHub App installation token / fine-grained PAT **into the box** | accepts residency; TTL+scope of the token                        |
| **GitHub Codespaces** ([troubleshooting docs](https://docs.github.com/en/codespaces/troubleshooting/troubleshooting-authentication-to-a-repository))                          | Credential-helper script (`gitcredential_github.sh`) returns a resident `GITHUB_TOKEN` to git                                              | resident for codespace life — **and has leaked** (see risk note) |

### Family C — OIDC / workload-identity exchange (an _upstream_ of A or B, not a third answer)

SPIFFE/SPIRE ([concepts](https://spiffe.io/docs/latest/spiffe-about/spiffe-concepts/)),
GitHub OIDC ([token exchange](https://steve-kaschimer.github.io/posts/2026-06-12-oidc-in-github-actions/)),
and Vault's SPIFFE auth method
([HashiCorp](https://www.hashicorp.com/en/blog/implementing-workload-identity-with-hashicorp-vault-and-spiffe))
let a workload present a signed identity (5-min JWT for GitHub OIDC; minutes-long
SVIDs for SPIRE) and **exchange it** for a short-lived downstream credential.
Crucially, this is a _minting_ story, not a _residency_ story: the exchanged
credential still lands in the workload. OIDC gives you a better way to **produce**
a Family-B token (no static app private key on the box) or to **authenticate the
guest to the broker** in Family A — it does **not**, by itself, make the gh-API
credential never-resident. No agent-sandbox product uses raw OIDC exchange as the
end state for GitHub creds; they use it to feed A or B.

---

## 2. Comparison table — mechanism × who × security × ops × fit

| Mechanism                                              | Who ships it                                                           | Security property                                                                                                           | Ops cost                                                                                                             | Where it fits                                                                                             |
| ------------------------------------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **CA-terminating CONNECT/egress proxy**                | Cloudflare Outbound Workers; Anthropic `sandbox-runtime`; Docker `sbx` | **Never-resident**; works for _any_ HTTPS client (gh/Octokit/curl) unmodified; proxy sees plaintext (host-controlled, fine) | Per-run/instance **ephemeral CA**; CA key must stay host-side; cert rotation; SNI handling; a proxy fleet or sidecar | Untrusted-agent sandbox where you already run an in-network peer and need to cover arbitrary API clients  |
| **Plain-HTTP-to-sidecar proxy** (no CA)                | Modal `credential-injection`; Automata git half (via `insteadOf`)      | Never-resident; **no CA to trust**; but only covers clients you can point at the proxy URL                                  | Sidecar + private network; per-client URL rewrite                                                                    | git (native rewrite); bespoke API clients you control — **not** general `gh`/`api.github.com`             |
| **Short-TTL scoped token (installation/fine-grained)** | GitHub Actions; Vercel Sandbox; Codespaces; App tokens                 | **Bounded residency**: token in guest, ≤1h, single-repo, per-permission                                                     | Token minting + revocation-on-teardown; audit minting/scope                                                          | Managed runtimes with **no** host peer (E2B, Daytona, Vercel)                                             |
| **OIDC / SPIFFE exchange**                             | GitHub OIDC; SPIRE+Vault                                               | No static long-lived secret on box; identity-scoped; but exchanged cred still resident                                      | Identity provider + trust policies + attestation                                                                     | Upstream of the above two — how to _mint_ B without a resident app key, or authenticate guest→broker in A |
| **Resident long-lived token (status quo)**             | Automata unbrokered default (`~/.git-credentials`); pre-fix Codespaces | Full residency; readable by a prompt-injected agent                                                                         | none                                                                                                                 | nothing new should adopt this                                                                             |

---

## 3. The risk that decides it — resident tokens are an exfil target for untrusted agents

This is not hypothetical for our threat model (agent = untrusted guest root that
can be prompt-injected). Codespaces shipped a resident `GITHUB_TOKEN` via a
credential helper that returns the token for **any** host git asks about, and it
was exploited: the **RoguePilot** flaw let Copilot in a codespace exfiltrate the
privileged `GITHUB_TOKEN` to a remote server via prompt injection
([The Hacker News](https://thehackernews.com/2026/02/roguepilot-flaw-in-github-codespaces.html)),
and the **Clone2Leak** class showed credential-helper responses leaking to
attacker hosts ([GMO Flatt](https://flatt.tech/research/posts/clone2leak-your-git-credentials-belong-to-us/)).
A resident token — even a 1-hour, repo-scoped one — is readable by the very agent
we don't trust, for as long as it lives. That is precisely why Anthropic's own
agent sandbox runtime and Cloudflare's agent Sandboxes chose **never-resident
TLS-terminating proxies** rather than handing the agent a token.

The counter-weight: a CA-terminating proxy requires placing a CA the guest trusts.
The feared failure ("guest can now MITM all its own TLS") is **not** actually a
credential-exfil risk _if the CA private key never enters the guest_ — the guest
trusting a CA it cannot sign with only means the host-controlled proxy can read the
guest's plaintext, which is already true and desired. Cloudflare's design makes
this explicit: a **unique ephemeral CA per instance, private key isolated in the
sidecar, never shared across instances**. The real ops costs are cert lifecycle
(per-run CA generation, rotation) and that TLS-pinned clients break — but `gh`,
Octokit, and curl all honor the standard CA env vars the runtime sets.

---

## 4. Decision 1 — the gh-API half

**Verdict: build it as a CA-terminating CONNECT proxy in the existing Docker
sidecar. Do NOT pivot the Docker plane to short-TTL resident tokens.**

Rationale, grounded in shipped products:

- Every enterprise product that solves _the same problem we have_ — authenticated
  API egress from an **untrusted agent** sandbox — uses a **TLS-terminating,
  credential-injecting proxy**: Cloudflare Outbound Workers, Anthropic
  `sandbox-runtime`, Docker `sbx`. None of them hands the agent an API token.
- The plain-HTTP-to-sidecar variant (Modal, our git half) can't cover the gh-API
  half: `api.github.com` callers won't downgrade to a loopback plain-HTTP URL the
  way git's `insteadOf` does. TLS interception is the only way to cover _arbitrary_
  API clients without a resident token.
- We already run the per-run sidecar and already do server-side token injection
  for git. Extending the **same sidecar** to CA-terminate `CONNECT api.github.com`
  and swap the per-run bearer → installation token is the coherent, minimal step —
  it keeps the never-resident property the Docker broker was built for.

**The tradeoff that decides it: residency vs. interception.** A short-TTL token is
operationally cheaper (no CA, no cert rotation, no TLS plumbing) but leaves a live,
prompt-injection-readable secret in an untrusted box. The CA-proxy costs a per-run
ephemeral CA and cert lifecycle but keeps the token never-resident. For an
untrusted agent, never-resident wins — that is the whole reason #117 exists, and
reverting to residency for the API half would reopen #89 on the Docker path.

**Non-negotiable constraints** (from Cloudflare's design): the CA must be
**per-run and ephemeral**, its **private key must never enter the guest** (mint
leaf certs inside the sidecar only), and the proxy must fail closed (today's 401)
if injection can't happen. Scope the injected installation token to the run's repo

- minimal permissions so a proxy compromise is still bounded.

---

## 5. Decision 2 — managed planes (E2B, Daytona)

> **⚠️ SUPERSEDED — see [`credential-brokering-decision.md`](./credential-brokering-decision.md).**
> This section concluded "accept bounded residency on the managed planes" on the
> premise that E2B and Daytona expose **no** host-controlled way to keep the
> credential out of the guest. The managed-provider spike
> ([`credential-brokering-managed-providers-spike.md`](./credential-brokering-managed-providers-spike.md))
> subsequently disproved that premise with SDK-type + provider-doc evidence: both
> providers ship a **native, never-resident** egress-layer credential-injection
> primitive (E2B `network.rules[host].transform.headers` + `Secret.fill()`;
> Daytona organization `Secrets` with `hosts:['github.com']` and
> `dtn_secret_<id>` placeholder substitution). The reconciled decision therefore
> makes **provider-native never-resident injection the primary** for managed
> planes and demotes the short-TTL resident token below to a **documented
> defense-in-depth / fallback** for repos or plans without access to those
> primitives. The rationale below is retained for the record; read it as the
> fallback path, not the recommendation.

Rationale (as originally written — now the fallback path):

- **The Docker pattern structurally can't transfer.** It depends on owning an
  `--internal` network and a sidecar the guest can't read. E2B and Daytona are
  managed: E2B **passes secrets as env vars visible inside the sandbox** and ships
  **no host-controlled in-network peer and no credential-injecting metadata
  endpoint** — its own guidance is to _"self-host a reverse proxy on separate
  infrastructure"_ for custom egress
  ([Vercel KB](https://vercel.com/kb/guide/vercel-sandbox-vs-e2b),
  [Blaxel](https://blaxel.ai/blog/e2b-alternatives-sandbox-environments)). Daytona
  offers only create-time allowlists. Neither gives you the peer Family A requires.
- **The only managed platform with a never-resident answer is one that built the
  runtime for it** — Cloudflare Sandboxes (Outbound Workers) and Anthropic's
  self-hosted `sandbox-runtime`. E2B/Daytona are not that; retrofitting Family A
  onto them means routing _all_ their egress through an **external** host-run
  CA-proxy fleet — an extra hop, added latency, and a proxy fleet you now operate,
  for planes that are already our secondary providers.
- **Every managed peer that lacks an in-network peer picks Family B.** Vercel
  Sandbox injects a GitHub App installation token / fine-grained PAT into the box;
  Codespaces uses a resident `GITHUB_TOKEN`; GitHub Actions mints a per-job token.
  The industry answer for this exact shape is **short-TTL scoped token, bounded by
  TTL + fine-grained scope**, not a never-resident broker.

**How to make the bounded-residency token as safe as it can be** (learning from the
Codespaces failures): mint a **GitHub App installation token per run**, scoped to
the **single repo** with only `contents` + `pull_requests` (+ what the run needs),
**1-hour TTL**, and **revoke on teardown**; mint it via **OIDC/App-key exchange**
so no static app private key sits on the box; audit every mint. Optionally use a
**fine-grained** scope so a leak can't pivot to other repos. This closes the _scope
and lifetime_ of #89 on managed planes even though it can't close _residency_.

**If a specific repo's compliance posture demands never-resident on a managed
plane**, the escape hatch is to route that repo's runs through the **same external
CA-terminating proxy** from Decision 1 (E2B's own recommended pattern), or to pin
the repo to the Docker/worker plane, which already brokers. Reserve that cost for
repos that actually require it.

---

## 6. What this means for #114

**Ship the gh-API half as a CA-terminating CONNECT proxy inside the existing
per-run Docker sidecar — not a pivot to short-TTL tokens.** That matches what every
untrusted-agent sandbox product ships (Cloudflare Outbound Workers, Anthropic
`sandbox-runtime`, Docker `sbx`), preserves the never-resident property the #117
Docker broker was built for, and covers arbitrary `gh`/Octokit/curl callers that a
plain-HTTP proxy can't. The hard requirements are a **per-run ephemeral CA whose
private key never leaves the sidecar**, fail-closed on injection failure, and a
repo-scoped installation token so a proxy compromise stays bounded. **For the
managed planes, use the providers' native never-resident credential injection**
(E2B `transform.headers` + `Secret.fill()`; Daytona `Secrets` host-substitution)
— see the reconciled [`credential-brokering-decision.md`](./credential-brokering-decision.md).
This section originally recommended pivoting the managed planes to short-TTL
resident tokens on the premise that E2B and Daytona expose no way to keep the
credential out of the guest; the managed-provider spike disproved that premise, so
short-TTL scoped tokens are now the **documented fallback / defense-in-depth**
(for repos or plans without access to the native primitives), not the primary.
Keep never-resident brokering everywhere it is reachable — the Docker sidecar
CA-proxy on the Docker plane, and the providers' own egress injection on E2B and
Daytona.
