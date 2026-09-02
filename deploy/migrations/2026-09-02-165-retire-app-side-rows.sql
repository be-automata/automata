-- #165 cutover, step 2 (run AFTER the www/worker deploy, box drained of
-- in_flight review runs): retire stored 'app-side' settings rows. The value is
-- rejected at the write boundary from this revision on; rows written by a
-- stale build during the window are caught by the verification below.
UPDATE repo_review_settings SET supersede_policy = NULL WHERE supersede_policy = 'app-side';

-- Post-migration verification (both counts MUST be 0; the second catches a
-- stale www instance writing the retired value after the cutover — substitute
-- the deploy timestamp):
--   SELECT count(*) FROM repo_review_settings WHERE supersede_policy = 'app-side';
--   SELECT count(*) FROM hatchet_run WHERE supersede_policy = 'app-side' AND created_at > '<deploy time>';
