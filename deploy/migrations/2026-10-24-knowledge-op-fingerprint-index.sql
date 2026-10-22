-- migrate:no-transaction
--
-- Rejection lookup index for knowledge_op (Phase 11 hand-off). Built
-- CONCURRENTLY so the existing table is not locked; it sorts after the column
-- file that adds evidence_fingerprint.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "knowledge_op_claim_evidence_fingerprint_index" ON "knowledge_op" USING btree ("claim_id","evidence_fingerprint");
