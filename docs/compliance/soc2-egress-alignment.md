# SOC 2 alignment — egress enforcement & execution-plane security (#62 / #66)

Status: adopted 2026-08-22 (owner decision). Scope: the egress-enforcement stack
(#101/#102/#103/#105/#106), its accepted deviations, and the remediation tail.
This maps our controls to the SOC 2 Trust Services Criteria (TSC), records each
accepted gap as a formal risk acceptance with compensating controls and a
remediation target, and states the deployment boundary the acceptances are
valid for.

## Deployment boundary (read first)

Every risk acceptance below is scoped to the **single-tenant pilot deployment**
(one operator, one worker box, first-party repos). **#108 (dedicated agent uid +
PF anchor) is a hard precondition for any multi-tenant expansion or for
processing customer data on the worker plane.** Outside the pilot boundary, the
acceptances in the register are void and the gaps become launch blockers.

### What the #108 PF anchor is, and is not, as a control

The anchor is a **best-effort backstop on one pilot box**, not a complete egress
control, and must not be presented as one:

- **Apple TN3165 (2024-02-27), "Packet Filter is not API":** PF "is not
  considered API", must not be used "in a software product that you distribute
  to a wide audience", and its rules "might clash with those installed by: The
  user; macOS system services, either now or in the future; Other third-party
  products."
- **macOS 15.0–15.3.1 had system processes bypassing `block all`**
  (`com.apple.geod`, `com.apple.WebKit`; Apple DevForums 776914). The pilot box
  is 15.7.3, past that range, but a PF-based egress claim cannot be asserted
  COMPLETE on macOS 15+.
- **Forwarded (VM / OrbStack / Docker) traffic is out of scope by construction.**
  `pf.conf(5)`: for forwarded connections "the user and group are unknown", and
  "user >= 0 does not match forwarded packets". Guest traffic reaching the host
  on a vmnet interface is neither matched nor blocked by a uid rule.
- **Not closed:** DNS tunnelling, ports other than 80/443, unix sockets to
  operator-uid listeners, and the deliberate bearer-protected loopback git/gh
  brokers.

The durable mechanism is NetworkExtension. Any expansion beyond the pilot
boundary should treat the PF anchor as an interim measure and re-review RA-1
against that, not close it.

### Observe mode and what `egress_events` rows mean (#108)

Under `WORKER_AGENT_USER` an agent-uid run with **no repo policy** gets an
**observe-mode** proxy: every destination is allowed and every decision is still
posted to the audit sink. This is deliberate — the proxy is loopback-only with
no client auth and the agent is handed its URL, so an un-audited allow-all would
be an open relay — but it changes what a row means. An `action:"allow"` row from
an observe run records that traffic HAPPENED; only a row produced under a repo
policy is evidence that a policy PERMITTED it. Worker-side events therefore carry
a `mode` marker. Persisting that marker control-plane-side (schema + column) is
an open follow-up; until it lands, enforcement evidence must be correlated with
whether the run's repo carried an `egress_policy`.

## Control mapping (TSC → implemented control → evidence)

| TSC                                             | Control                                                                                                                                                                                                       | Status                                                   | Evidence                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| CC6.1 / CC6.3 — logical access, least privilege | Review-lane agents hold NO GitHub credential (emit-only review, credential fence); per-run revocable tokens; local git broker keeps the installation token in worker heap only                                | Implemented                                              | #65/#79/#80 (fence regression-pinned); ADR-003/004                           |
| CC6.6 — network boundaries                      | Per-repo egress policy (`none\|ip_port\|domain`) enforced at the network layer on all four planes: worker filtering proxy, Docker internal-net + sidecar, E2B native firewall, Daytona domainAllowList        | Implemented                                              | #101–#103, #105, #106; live prod run + per-plane E2E records on #66          |
| CC6.7 — restrict data movement                  | Deny-by-default under policy; system hosts explicit and control-plane-resolved; `none`-level host list documented (#110-e)                                                                                    | Implemented (docs item open)                             | `packages/shared/src/model/egress-policy.ts` CONTRACT NOTE; #66 AC4 sign-off |
| CC7.2 — monitoring & anomalous activity         | `egress_events` audit sink: worker plane full per-connection (allow+deny, run-id-stamped); Docker sidecar logs decisions (DB shipping = #109); E2B/Daytona enforced-but-unaudited per connection (vendor gap) | Partial — **top remediation priority under this policy** | #101 sink; live prod deny rows incl. organic block; #109, #110-a/c/d         |
| CC7.3 / CC7.4 — incident detection & response   | Review-pipeline failure forensics runbook + ops memory (5 documented failure modes); #107 makes infra failures self-identifying + auto-requeued                                                               | Partial (#107 designed, not implemented)                 | #107 + its design comment; incident records 2026-08-21/22                    |
| CC8.1 — change management                       | Every change lands via PR with mandatory automated review (Automata bot) + green CI; ADRs record invariants; composability grep gate per PR                                                                   | Implemented                                              | PRs #101–#106 (all bot-APPROVED + green); docs/adr                           |
| CC9.2 — vendor risk                             | Version-gap monitoring of all provider SDKs and harness CLIs (pins vs latest, risk-rated); Dependabot; vendor feature requests for audit feeds                                                                | Implemented (requests = #110-c)                          | Version Gap Radar (2026-08-22); #62 research records                         |

## Risk-acceptance register

Formal acceptances by the owner (2026-08-22, recorded on #66). Review cadence:
each acceptance is re-reviewed at its target date or at any scope change,
whichever comes first.

| ID   | Accepted gap                                                                                              | Residual risk                                                                                                  | Compensating controls                                                                                                               | Remediation                                                                                                                              | Target (proposed)                          |
| ---- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| RA-1 | Worker-plane PF backstop not loaded (shipped uid rule cannot discriminate on the dual-use pilot box)      | An env-unsetting agent on the worker plane can exfiltrate repo contents + its harness credential **unaudited** | No GitHub credential in the review lane; all cooperative traffic proxied + audited; other 3 planes un-bypassable; single-tenant box | #108 ships the dedicated `_automata-agent` uid, the persistent anchor and the proxy-aware daemon callback. NOTE: closing RA-1 on the anchor alone would overclaim — see "What the #108 PF anchor is, and is not" above; the anchor is a pilot-box backstop, NetworkExtension is the durable control | 2026-09-19                                 |
| RA-2 | E2B/Daytona denies enforced natively but not per-connection audited (no vendor event feed)                | A blocked exfil attempt on those planes leaves no audit row                                                    | Enforcement is below the process (un-bypassable); worker/Docker planes audit fully; industry-consistent (9-system benchmark on #66) | #110-a (per-run policy-snapshot row makes the gap itself auditable), #110-c (vendor requests), #110-d (canary probe); Docker half = #109 | #109 + #110-a: 2026-09-05                  |
| RA-3 | AC4: `none` still permits declared system hosts (github.com until #81; api.anthropic.com on box-key runs) | Slightly wider `none` than the literal AC                                                                      | Hosts are explicit, control-plane-resolved, and documented; industry-consistent (providers default-allow these)                     | #81 removes github.com/api.github.com from `none`; docs surfacing = #110-e                                                               | #81: existing schedule; #110-e: 2026-09-05 |
| RA-4 | Review verdict failures conflate 5 infra causes into one message; no auto-retry                           | Slow incident triage; occasional manual re-review                                                              | Fail-loud guarantee (never a silent pass); forensics runbook + ops memory                                                           | #107 (kind discriminant, requeue-then-comment, sweep-visible marker — design recorded on issue)                                          | 2026-09-12                                 |

Target dates are proposed by the platform agent and stand unless the owner
amends them on the linked issues; each issue carries its date.

## Priority ordering under this policy

CC7.2 is the widest genuine gap, so audit-trail work leads: **#109 and #110-a
first**, then **#107** (incident self-identification), then **#108** (least-
privilege separation — the multi-tenant gate). #81 proceeds on its own track
and mechanically shrinks RA-3.

## Evidence index

- Delivery + verification evidence: the Security Horizon Delivery report
  (artifact, 2026-08-22) and the #66 comment trail (live prod observation,
  per-plane E2E matrices, template/snapshot verification).
- Industry benchmark: 9-system comparison recorded on #66 (Harden-Runner, E2B,
  Daytona, Modal, Cloudflare, Vercel, Codex CLI, Anthropic srt/Claude Code,
  K8s/Cilium) — the two benchmarked deviations (RA-2 vendor audit gap, RA-3
  system-host allowance) are at or ahead of prevailing practice.
- Change-management evidence: PRs #101–#106, each Automata-bot APPROVED on the
  final head with green CI.
