-- migrate:expand
--
-- ADR-014 step 5, slice 1: the two profiles of Automata's own box, with the
-- evidence ADR-014 already records, so the shadow resolver's decisions mean
-- something from the first dispatch. Data only, idempotent (re-running inserts
-- nothing). No probe writes evidence yet; the next renewal is a new row, never
-- an edit (expires_at is generated from measured_at).
--
-- config_hash = sha256 of the canonical JSON of configuration, exactly as
-- executionProfileConfigHash (packages/shared/src/model/execution-profiles.ts)
-- computes it; a test there pins both hashes below.
--
-- Evidence (docs/adr/ADR-014-third-party-execution-compute.md, Consequences,
-- "Evidence upkeep", and ADR-013's acceptance record):
--   automata-box/observe  production, driver B on automata-exec-1,
--                         2026-11-08 17:48Z, probes 2 to 7 (12/12), platform
--                         1f58cf7. Probe 1 not re-measured: egress stays open,
--                         and the policy says egress_open for egress_mode
--                         observe anyway. Expires 2026-12-08.
--   automata-box/enforce  throwaway box with enforced egress, driver A,
--                         2026-10-25 09:56Z, all seven probes. Expires
--                         2026-11-24. dns_closed is read from the design
--                         (--network none, decide() before lookup) on top of
--                         probe 1, as the ADR records it.
-- The batteries image digest is recorded truncated in the ADR, so
-- artifact_digest stays NULL rather than carrying a guess.

INSERT INTO "execution_profile" ("id", "provider", "tier", "configuration", "config_hash")
VALUES
  ('automata-box/observe', 'automata-box', 'customer_box', '{"egress_mode":"observe"}'::jsonb,
   encode(sha256(convert_to('{"egress_mode":"observe"}', 'UTF8')), 'hex')),
  ('automata-box/enforce', 'automata-box', 'customer_box', '{"egress_mode":"enforce"}'::jsonb,
   encode(sha256(convert_to('{"egress_mode":"enforce"}', 'UTF8')), 'hex'))
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "profile_evidence" ("profile_id", "capability", "measured_at", "source", "platform_sha", "result")
SELECT e.profile_id, e.capability, e.measured_at, 'conformance', e.platform_sha, e.result
FROM (VALUES
  ('automata-box/observe', 'metadata_blocked', timestamp '2026-11-08 17:48:00', '1f58cf7',
   '{"value": true, "probes": "2-7", "driver": "B", "host": "automata-exec-1"}'::jsonb),
  ('automata-box/observe', 'peer_isolated', timestamp '2026-11-08 17:48:00', '1f58cf7',
   '{"value": true, "probes": "2-7", "driver": "B", "host": "automata-exec-1"}'::jsonb),
  ('automata-box/observe', 'teardown_verified', timestamp '2026-11-08 17:48:00', '1f58cf7',
   '{"value": true, "probes": "2-7", "driver": "B", "host": "automata-exec-1"}'::jsonb),
  ('automata-box/observe', 'secret_brokering', timestamp '2026-11-08 17:48:00', '1f58cf7',
   '{"value": true, "probes": "2-7", "driver": "B", "host": "automata-exec-1"}'::jsonb),
  ('automata-box/observe', 'provider_creds_in_guest', timestamp '2026-11-08 17:48:00', '1f58cf7',
   '{"value": false, "probes": "2-7", "driver": "B", "host": "automata-exec-1"}'::jsonb),
  ('automata-box/enforce', 'metadata_blocked', timestamp '2026-10-25 09:56:00', '1f58cf7',
   '{"value": true, "probes": "1-7", "driver": "A", "host": "throwaway"}'::jsonb),
  ('automata-box/enforce', 'peer_isolated', timestamp '2026-10-25 09:56:00', '1f58cf7',
   '{"value": true, "probes": "1-7", "driver": "A", "host": "throwaway"}'::jsonb),
  ('automata-box/enforce', 'teardown_verified', timestamp '2026-10-25 09:56:00', '1f58cf7',
   '{"value": true, "probes": "1-7", "driver": "A", "host": "throwaway"}'::jsonb),
  ('automata-box/enforce', 'secret_brokering', timestamp '2026-10-25 09:56:00', '1f58cf7',
   '{"value": true, "probes": "1-7", "driver": "A", "host": "throwaway"}'::jsonb),
  ('automata-box/enforce', 'provider_creds_in_guest', timestamp '2026-10-25 09:56:00', '1f58cf7',
   '{"value": false, "probes": "1-7", "driver": "A", "host": "throwaway"}'::jsonb),
  ('automata-box/enforce', 'egress', timestamp '2026-10-25 09:56:00', '1f58cf7',
   '{"value": "allowlist", "probes": "1", "driver": "A", "host": "throwaway"}'::jsonb),
  ('automata-box/enforce', 'dns_closed', timestamp '2026-10-25 09:56:00', '1f58cf7',
   '{"value": true, "probes": "1", "driver": "A", "host": "throwaway", "basis": "--network none leaves no resolver; the proxy decides before any lookup"}'::jsonb)
) AS e(profile_id, capability, measured_at, platform_sha, result)
WHERE NOT EXISTS (
  SELECT 1 FROM "profile_evidence" p
  WHERE p.profile_id = e.profile_id
    AND p.capability = e.capability
    AND p.measured_at = e.measured_at
);
