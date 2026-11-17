-- migrate:expand
--
-- ADR-014 (#634 S4): the profile of an OpenSandbox cell on the runc runtime.
-- Data only, idempotent (re-running inserts nothing). It seeds NO evidence:
-- evidence for this profile arrives only through the ingest route, from a
-- conformance run, so the profile is inert (egress not enforced) until then.
--
-- config_hash = sha256 of the canonical JSON of configuration, exactly as
-- executionProfileConfigHash (packages/shared/src/model/execution-profiles.ts)
-- computes it; a test there pins the hash. The unique (provider, tier,
-- config_hash) index does not collide with automata-box/enforce: the provider
-- differs.

INSERT INTO "execution_profile" ("id", "provider", "tier", "configuration", "config_hash")
VALUES
  ('opensandbox/runc', 'opensandbox', 'customer_box', '{"egress_mode":"enforce"}'::jsonb,
   encode(sha256(convert_to('{"egress_mode":"enforce"}', 'UTF8')), 'hex'))
ON CONFLICT ("id") DO NOTHING;
