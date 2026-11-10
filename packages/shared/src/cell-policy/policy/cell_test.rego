package cell_test

import data.cell

now := "2026-11-08T12:00:00Z"

server := {f: "server" | some f in cell.required_cell_fields}

synthetic_cell := {
	"data_class": "synthetic",
	"repo_visibility": "public",
	"untrusted_content": false,
	"irreversible": false,
	"lane": "implement",
	"secrets": [],
	"needs_egress": ["gateway.example"],
}

allowlist_profile := {
	"id": "agent37/gvisor/allowlist",
	"provider": "agent37",
	"tier": "managed",
	"capabilities": {
		"egress": "allowlist",
		"egress_allowlist": ["gateway.example"],
		"dns_closed": false,
		"metadata_blocked": true,
		"peer_isolated": true,
		"teardown_verified": true,
		"provider_creds_in_guest": true,
		"provider_endpoints_reachable": false,
	},
	"evidence": {"source": "conformance", "run": "test", "measured_at": "2026-11-08T00:00:00Z", "expires_at": "2026-12-08T00:00:00Z"},
	"legal": {"status": "embedding_allowed", "expires_at": "2027-05-06T00:00:00Z"},
}

# object.union merges nested objects, so removing a nested key needs a full replace.
replace(o, k, v) := object.union(object.remove(o, [k]), {k: v})

req(c, p) := {"now": now, "cell": c, "provenance": server, "profile": p}

denied_with(input_doc, reason) if {
	d := cell.decision with input as input_doc
	d.allow == false
	reason in d.reasons
}

# ---------------------------------------------------------------- the happy path exists

test_synthetic_cell_on_allowlist_profile_is_allowed if {
	d := cell.decision with input as req(synthetic_cell, allowlist_profile)
	d.allow
	d.reasons == []
}

# ---------------------------------------------------------------- the three the ADR asks for

test_missing_field_denies if {
	c := object.remove(synthetic_cell, ["data_class"])
	denied_with(req(c, allowlist_profile), "missing_field:data_class")
}

test_expired_evidence_denies if {
	p := object.union(allowlist_profile, {"evidence": object.union(allowlist_profile.evidence, {"expires_at": "2026-11-08T11:59:59Z"})})
	denied_with(req(synthetic_cell, p), "evidence_expired")
}

test_self_declared_input_denies if {
	i := object.union(req(synthetic_cell, allowlist_profile), {"provenance": object.union(server, {"untrusted_content": "client"})})
	denied_with(i, "self_declared:untrusted_content")
}

test_missing_provenance_counts_as_self_declared if {
	i := object.remove(req(synthetic_cell, allowlist_profile), ["provenance"])
	denied_with(i, "self_declared:data_class")
}

# ---------------------------------------------------------------- deny by default

test_empty_input_denies if {
	d := cell.decision with input as {}
	d.allow == false
	"unknown_profile" in d.reasons
	"missing_now" in d.reasons
	"evidence_missing" in d.reasons
}

test_evidence_from_elsewhere_denies if {
	p := object.union(allowlist_profile, {"evidence": object.union(allowlist_profile.evidence, {"source": "vendor_docs"})})
	denied_with(req(synthetic_cell, p), "evidence_not_from_conformance")
}

# ---------------------------------------------------------------- capabilities: absent = not proven

test_unproven_metadata_block_denies if {
	p := replace(allowlist_profile, "capabilities", object.remove(allowlist_profile.capabilities, ["metadata_blocked"]))
	denied_with(req(synthetic_cell, p), "metadata_not_proven_blocked")
}

test_open_egress_denies if {
	p := object.union(allowlist_profile, {"capabilities": object.union(allowlist_profile.capabilities, {"egress": "open"})})
	denied_with(req(synthetic_cell, p), "egress_open")
}

test_observe_mode_counts_as_open_egress if {
	# Measured capabilities say allowlist, but the proxy runs in observe mode: open.
	p := object.union(allowlist_profile, {"configuration": {"egress_mode": "observe"}})
	denied_with(req(synthetic_cell, p), "egress_open")
}

test_enforce_mode_keeps_measured_egress if {
	p := object.union(allowlist_profile, {"configuration": {"egress_mode": "enforce"}})
	d := cell.decision with input as req(synthetic_cell, p)
	d.allow
}

test_host_outside_allowlist_denies if {
	c := object.union(synthetic_cell, {"needs_egress": ["gateway.example", "attacker.example"]})
	denied_with(req(c, allowlist_profile), "egress_host_not_allowed:attacker.example")
}

# ---------------------------------------------------------------- risks: unmeasured = present

test_untrusted_content_with_provider_creds_and_open_dns_denies if {
	c := object.union(synthetic_cell, {"untrusted_content": true})
	denied_with(req(c, allowlist_profile), "provider_creds_exfiltrable_by_dns")
}

test_unmeasured_provider_risks_count_as_present if {
	# DNS proven closed, but nobody measured the provider's tokens or endpoints: still denied.
	p := replace(allowlist_profile, "capabilities", object.union(
		object.remove(allowlist_profile.capabilities, ["provider_creds_in_guest", "provider_endpoints_reachable"]),
		{"dns_closed": true},
	))
	c := object.union(synthetic_cell, {"untrusted_content": true})
	denied_with(req(c, p), "provider_endpoints_reachable")
}

test_untrusted_content_allowed_when_dns_closed_and_endpoints_unreachable if {
	p := object.union(allowlist_profile, {"capabilities": object.union(allowlist_profile.capabilities, {"dns_closed": true})})
	c := object.union(synthetic_cell, {"untrusted_content": true})
	d := cell.decision with input as req(c, p)
	d.allow
}

# ---------------------------------------------------------------- secrets

test_secrets_without_brokering_deny if {
	c := object.union(synthetic_cell, {"secrets": ["github_write"]})
	denied_with(req(c, allowlist_profile), "secrets_need_brokering")
	denied_with(req(c, allowlist_profile), "secrets_exfiltrable_by_dns")
}

# ---------------------------------------------------------------- managed tier bars

test_managed_tier_bars if {
	denied_with(req(object.union(synthetic_cell, {"repo_visibility": "private"}), allowlist_profile), "private_repo_barred")
	denied_with(req(object.union(synthetic_cell, {"data_class": "pii"}), allowlist_profile), "data_class_barred:pii")
	denied_with(req(object.union(synthetic_cell, {"irreversible": true}), allowlist_profile), "irreversible_barred")
	denied_with(req(object.union(synthetic_cell, {"lane": "review"}), allowlist_profile), "review_lane_barred")
}

test_missing_or_expired_legal_record_denies if {
	denied_with(req(synthetic_cell, object.remove(allowlist_profile, ["legal"])), "legal_record_missing")
	p := object.union(allowlist_profile, {"legal": {"status": "embedding_allowed", "expires_at": "2026-01-01T00:00:00Z"}})
	denied_with(req(synthetic_cell, p), "legal_record_expired")
}

test_customer_box_is_not_held_to_managed_bars if {
	p := object.union(allowlist_profile, {"tier": "customer_box", "capabilities": object.union(allowlist_profile.capabilities, {"provider_creds_in_guest": false})})
	c := object.union(synthetic_cell, {"repo_visibility": "private", "data_class": "internal"})
	d := cell.decision with input as req(c, p)
	d.allow
}
