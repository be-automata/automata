# ADR-014: Third-party execution compute under Automata's account, gated by one profile resolver

- **Status:** Accepted (2026-11-09) by the operator. Proposed 2026-11-08 (#571). Step 5 of Testing starts now.
- **Date:** 2026-11-08
- **Context source:**
  - `docs/adr/ADR-002-per-org-execution-plane.md:97`: "we do not host or bill for execution compute".
  - `docs/adr/ADR-002-per-org-execution-plane.md:459`: R3.8, Tier C, the customer's own provider account.
  - `docs/adr/ADR-005-monotone-permission-and-posture-floors.md:69` (§3b, single shared resolver) and `:83` (§5, enforced at the seam).
  - `docs/adr/ADR-013-image-per-run-execution.md:142` (Decision 5), `:150` (Decision 6), `:287` (acceptance record) and `:390` (I7, one execution path).
  - `packages/worker/src/agent-run/container-argv.ts` (`buildContainerCreateArgv`, `assertHardenedArgv`).
  - `packages/worker/src/agent-run/egress-proxy.ts` (`decide` before lookup in `handleConnect`).
  - `packages/worker/deploy/linux/container-security-probes.sh`.
- **Deciders:** operator.
- **Relates to:** ADR-002, ADR-003, ADR-004, ADR-005, ADR-011, ADR-013.
- **Supersedes:** in ADR-002, only the Decision §2 sentence on hosting and billing, and the R3.8 closing phrase "without the platform ever hosting agent compute". The rest of ADR-002 stands. ADR-013 I7 is amended (see Consequences).

## Context

ADR-002 chose customer-supplied compute. That removes compute cost and custody from Automata, and it also adds friction: every customer has to provide a box or a provider account. The operator wants to reuse third-party execution services so a customer can start with no box. The candidate is Agent37, on Automata's own account. Its terms allow building it into a product (§6) and bar reselling bare access as a hosting platform without a written agreement (§7).

The architecture review (2026-11-06) found two things. A broker outside the guest protects the secret, not the authority or the data. And Agent37 documents no per-host egress allowlist.

Conformance was measured on 2026-11-08 by a CLI script over Agent37's API, gVisor and VM, with JSON evidence and no adapter. It corrected the second finding: the create call takes an undocumented `network` field (`"allow-all"` by default, `"deny-all"`, or `{ "allow": [hosts] }`).

- **`deny-all`** closes all egress, DNS included, and also Agent37's own LLM, search and MCP proxies.
- **`{ "allow": [...] }`** filters TLS by SNI: a name not on the list gets `TLSV1_ALERT_ACCESS_DENIED`, also on an allowed IP. It refuses every port other than 443. DNS stays open: arbitrary names resolve, and direct UDP to 8.8.8.8 answers. That is an exfiltration channel.
- **Credentials in the guest:** every instance gets Agent37 credentials in its environment (`AGENT37_MANAGED_TOKEN`, `AGENT37_STARTER_TOKEN`, `OPENCLAW_STARTER_TOKEN`), even on `agent37-base`.
- **What holds:** metadata, the host gateway and other instances are unreachable, edge auth is enforced, and teardown is verified.

Automata's own box is the baseline every profile is compared against. ADR-013's acceptance record is its evidence (`ADR-013…md:287`):

- **Production, 2026-10-24:** probes 2 to 7 pass.
- **Throwaway box with enforced egress, 2026-10-25:** all seven pass.

Production egress is in observe mode, because no onboarded repo has an enforced policy. In observe mode the proxy allows every destination and audits it. In enforce mode `decide()` refuses a name before any lookup, and the container has no resolver (`--network none`), so a denied name is never resolved.

## Decision

1. **A managed tier beside the box.** Automata may run execution cells on third-party compute under its own account, as a tier beside the customer's box. The customer's box and BYOC remain available. They are the only option for a cell that is barred from the managed tier.
2. **One resolver decides.** A cell runs on a profile (provider, tier, configuration) only when one control-plane resolver allows it. The resolver denies by default and takes inputs derived on the server. It runs at compile, dispatch and resume. This extends ADR-005 §3b with a monotone allowed-profiles axis.
3. **Evidence expires.** A capability without current evidence counts as absent. Evidence comes from a conformance run and expires after 30 days. Our own box is held to the same rule, with ADR-013's probes as its conformance run.
4. **Terms are legal records.** Provider terms go in the catalog as legal records, with document, date and expiry. They are not capabilities.
5. **Metered compute.** Execution compute on this tier is metered per organization and may be billed. Metering uses a maintained meter rather than a custom one. Which one is open.

## Anti-deviation invariants

- **No long-lived credentials.** No cell on this tier receives a long-lived credential, a cloud token, or Automata's provider key.
- **No reuse.** An instance is never reused across missions or organizations.
- **Refuse, never redirect.** Without a passing resolver decision, the run is refused with a named reason, never redirected to another profile.
- **Barred on a profile without proven closed egress and DNS:** private repositories, untrusted pull requests, irreversible or production steps, personal or residency-bound data, and the review lane (ADR-004).
- **Observe is not enforce.** A box in observe mode counts as open egress for the resolver.

## Options considered

- **Keep ADR-002 as is.** No custody and no compute cost, but more friction. Remains the default for sensitive work.
- **The customer's provider account (R3.8 Tier C).** Keeps custody and terms with the customer, and still needs an account. Stays available.
- **Automata's account (chosen).** Lowest friction. Takes on cost, custody, sub-processor duties and terms risk.
- **Our own compute on bare metal.** Contradicts the principle of adopting maintained infrastructure.

## Consequences

Positive:

- A customer can start with no box.
- Providers are swapped by profile, not by code path.
- The resolver puts numbers on our own box too. On 2026-11-08 the box in enforce mode allows the six reference scenarios, and in observe mode allows none.

Negative, to watch:

- **Model key custody.** ADR-002 §4's benefit is lost on this tier if a customer's model key reaches our account; a capped gateway token is needed instead. On our own box the model credential is already copied into the container by design (ADR-013 Run path).
- **Processor duties.** Automata becomes a processor of customer data on third-party infrastructure, so a DPA and a sub-processor list are needed. Agent37 keeps backups, account data and logs in the US.
- **Provider risk.** A provider outage or price change becomes Automata's problem. Agent37 publishes no SLA figure.
- **Margin and abuse.** Compute margin and abuse handling become our concern.
- **Terms.** §7 of Agent37's terms needs a written reading before selling. It has had no legal review.
- **ADR-013 I7.** "There is one execution path" becomes one path per profile, chosen only by the resolver. No setting or client input selects a path.
- **Remote cells cannot rely on the worker heap.** On our box, a worker crash takes its brokers with it. A dead worker's containers are removed by label at boot, and a redelivered run removes its predecessor by slot name. For a remote cell the adapter needs three things: a bearer whose TTL is bounded by the step timeout, revocation from the boot sweep, and an idempotency key on every effect.
- **Evidence upkeep.** Under decision 3, box evidence expires 30 days after it is measured.
  - **Throwaway box (enforced egress):** all seven probes, 2026-10-25 09:56Z, expires on 2026-11-24. Renewing it needs driver A on a repo with an enforced policy.
  - **Production:** the ADR-013 record (2026-10-24 12:26Z) would have expired on 2026-11-23. It was renewed on 2026-11-08 17:48Z by driver B on `automata-exec-1` (probes 2 to 7 in two concurrent review containers, 12/12), so it now expires on 2026-12-08. Driver B does not re-measure probe 1, so production stays open egress for the resolver.
  - The probes in `packages/worker/deploy/README.md` have to be re-run on a schedule.

## Testing

1. **Done 2026-11-08: conformance on Agent37.** CLI script on gVisor and VM, with probes, a canary and DNS checks, under `allow-all`, `deny-all` and an allowlist. JSON evidence, no adapter.
2. **Done: conformance on the box.**
   - Locally, ADR-013's flags pass and Docker with default settings fails.
   - On the box, ADR-013's acceptance record stands: probes 2 to 7 in production, all seven on the throwaway box.
   - Renewed in production on 2026-11-08 17:48Z: driver B, probes 2 to 7, 12/12 PASS (batteries `sha256:da029c44…`, platform `1f58cf7`).
3. **Done 2026-11-08: the `allow_cell` rule in OPA.** 17/17 tests. The matrix covers eight profiles, including the box in observe and enforce mode. With the clock moved past expiry, every profile is denied with `evidence_expired`.
4. **Done 2026-11-08: `kind: cell` in a local Hatchet spike, 25/25.** Covered:
   - resolution at compile and again at dispatch;
   - a blind tool behind a broker;
   - a stolen bearer refused;
   - revocation mid-run (168 ms);
   - evidence that expires between compile and dispatch refused at dispatch;
   - a hash-chained ledger that detects tampering.
5. **After acceptance:**
   - the resolver at the shared seam (ADR-005 §3b);
   - the Agent37 adapter over the existing run path;
   - the remote-cell crash case;
   - a scheduled re-run of the box probes.
