# allow_cell: may this execution cell run on this execution profile? (ADR-014 Decision 2)
#
# Deny by default, every denial named. Inputs are derived on the server (control plane resolver,
# ADR-005 §3b); the profile record comes from a conformance run and expires (ADR-014 Decision 3).
# Called at compile, dispatch and resume.
#
# Carried over from the 2026-11-08 spike (17/17 tests) with one addition: a profile whose
# configuration says egress_mode "observe" counts as open egress (ADR-014 invariant "Observe is
# not enforce").
#
# The compiled WASM (../cell.wasm, entrypoint cell/decision) is committed; regenerate it with
# packages/shared/scripts/build-cell-policy.sh after any change here. CI fails on a mismatch.
#
# input = {
#   "now":        RFC 3339, from the server clock,
#   "cell":       {data_class, repo_visibility, untrusted_content, irreversible, lane, secrets, needs_egress},
#   "provenance": {<cell field>: "server" | anything else},
#   "profile":    {id, provider, tier, configuration, capabilities, evidence, legal},
# }
package cell

required_cell_fields := {
	"data_class", "repo_visibility", "untrusted_content",
	"irreversible", "lane", "secrets", "needs_egress",
}

# Data classes a third-party (managed) tier may hold. Everything else stays on the customer's box.
managed_data_classes := {"public", "synthetic"}

cell := object.get(input, "cell", {})

profile := object.get(input, "profile", {})

caps := object.get(profile, "capabilities", {})

# A protective capability without current evidence counts as absent.
proven(name) if object.get(caps, name, false) == true

# A risk that was not measured counts as present.
risky(name) if object.get(caps, name, true) != false

decision := {"allow": count(reasons) == 0, "reasons": sort([r | some r in reasons])}

allow_cell := decision.allow

# ---------------------------------------------------------------- inputs

reasons contains "missing_now" if not input.now

reasons contains "unknown_profile" if not profile.id

reasons contains sprintf("missing_field:%s", [f]) if {
	some f in required_cell_fields
	not f in object.keys(cell)
}

reasons contains sprintf("self_declared:%s", [f]) if {
	some f in required_cell_fields
	f in object.keys(cell)
	object.get(input, ["provenance", f], "") != "server"
}

# ---------------------------------------------------------------- evidence

reasons contains "evidence_missing" if not profile.evidence.expires_at

reasons contains "evidence_not_from_conformance" if {
	profile.evidence
	profile.evidence.source != "conformance"
}

reasons contains "evidence_expired" if {
	time.parse_rfc3339_ns(profile.evidence.expires_at) <= time.parse_rfc3339_ns(input.now)
}

# ---------------------------------------------------------------- isolation every tier must prove

reasons contains "egress_open" if not object.get(caps, "egress", "") in {"none", "allowlist"}

# An egress proxy in observe mode allows every destination and only audits it.
reasons contains "egress_open" if object.get(profile, ["configuration", "egress_mode"], "") == "observe"

reasons contains sprintf("egress_host_not_allowed:%s", [h]) if {
	some h in object.get(cell, "needs_egress", [])
	not h in object.get(caps, "egress_allowlist", [])
}

reasons contains "metadata_not_proven_blocked" if not proven("metadata_blocked")

reasons contains "peer_isolation_not_proven" if not proven("peer_isolated")

reasons contains "teardown_not_proven" if not proven("teardown_verified")

# ---------------------------------------------------------------- secrets

reasons contains "secrets_need_brokering" if {
	count(object.get(cell, "secrets", [])) > 0
	not proven("secret_brokering")
}

reasons contains "secrets_exfiltrable_by_dns" if {
	count(object.get(cell, "secrets", [])) > 0
	not proven("dns_closed")
}

# The provider puts its own tokens in the guest. With untrusted content in the cell, an injected
# instruction could read them and send them out by DNS, or spend them on the provider's endpoints.
reasons contains "provider_creds_exfiltrable_by_dns" if {
	object.get(cell, "untrusted_content", true) != false
	risky("provider_creds_in_guest")
	not proven("dns_closed")
}

reasons contains "provider_endpoints_reachable" if {
	object.get(cell, "untrusted_content", true) != false
	risky("provider_creds_in_guest")
	risky("provider_endpoints_reachable")
}

# ---------------------------------------------------------------- third-party (managed) tier

managed if profile.tier == "managed"

reasons contains sprintf("data_class_barred:%s", [cell.data_class]) if {
	managed
	not cell.data_class in managed_data_classes
}

reasons contains "private_repo_barred" if {
	managed
	object.get(cell, "repo_visibility", "private") != "public"
}

reasons contains "irreversible_barred" if {
	managed
	object.get(cell, "irreversible", true) != false
}

reasons contains "review_lane_barred" if {
	managed
	cell.lane == "review"
}

reasons contains "legal_record_missing" if {
	managed
	not object.get(profile, ["legal", "status"], "") in {"cleared", "embedding_allowed"}
}

reasons contains "legal_record_missing" if {
	managed
	not profile.legal.expires_at
}

reasons contains "legal_record_expired" if {
	managed
	time.parse_rfc3339_ns(profile.legal.expires_at) <= time.parse_rfc3339_ns(input.now)
}
