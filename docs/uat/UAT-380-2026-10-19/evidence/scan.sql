-- #380 AC 2: engine rows written after the cutover must hold no run secret.
-- Scans every payload-bearing column the catalog knows (v1_task*.input,
-- v1_payload*.inline_content, v1_payloads_olap*, v1_tasks_olap*.input,
-- v1_dags_olap*.input) — the same discovery the hatchet IT uses.
-- Usage (the only form): substitute the bound, then run the file —
--   sed "s/__CUTOVER__/2026-10-19T16:41:12Z/" scan.sql > /tmp/scan.sql
--   docker exec automata-hatchet-postgres-1 psql -U hatchet -d hatchet -q -f /tmp/scan.sql
-- A parent partition and its day partition both report (the parent repeats the child).
\set ON_ERROR_STOP on
DO $$
DECLARE
  r record;
  n_total bigint;
  n_secret bigint;
  tcol text;
  q text;
BEGIN
  RAISE NOTICE 'table | column | rows after cutover | rows with a secret';
  FOR r IN
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND (
        (c.table_name LIKE 'v1\_task%' AND c.column_name = 'input')
        OR (c.table_name LIKE 'v1\_payload%' AND c.column_name = 'inline_content')
        OR (c.table_name LIKE 'v1\_payloads\_olap%' AND c.column_name IN ('inline_content','input'))
        OR (c.table_name LIKE 'v1\_tasks\_olap%' AND c.column_name = 'input')
        OR (c.table_name LIKE 'v1\_dags\_olap%' AND c.column_name = 'input')
      )
      AND c.table_name NOT LIKE '%cutover%'
    ORDER BY 1, 2
  LOOP
    -- the row's time column: inserted_at where present, else created_at
    SELECT column_name INTO tcol FROM information_schema.columns
     WHERE table_schema='public' AND table_name=r.table_name
       AND column_name IN ('inserted_at','created_at')
     ORDER BY CASE column_name WHEN 'inserted_at' THEN 0 ELSE 1 END LIMIT 1;
    IF tcol IS NULL THEN
      RAISE NOTICE '% | % | (no time column, skipped)', r.table_name, r.column_name;
      CONTINUE;
    END IF;
    -- position(), not LIKE: in LIKE the '_' of 'ghs_' is a wildcard and the
    -- escaping differs between literal forms; position() matches the bytes.
    -- Field names are matched as EXACT JSON keys ("name"), because the input
    -- legitimately carries the non-secret "githubReadTokenExpiresAt", which a
    -- bare 'githubReadToken' substring would count as a secret.
    q := format('SELECT count(*), count(*) FILTER (WHERE position(''ghs_'' in %I::text) > 0 OR position(''"installationToken"'' in %I::text) > 0 OR position(''"daemonToken"'' in %I::text) > 0 OR position(''"githubReadToken"'' in %I::text) > 0 OR position(''"checkToken"'' in %I::text) > 0 OR position(''"gateToken"'' in %I::text) > 0) FROM %I WHERE %I > %L::timestamptz',
                r.column_name, r.column_name, r.column_name, r.column_name, r.column_name, r.column_name,
                r.table_name, tcol, '__CUTOVER__');
    EXECUTE q INTO n_total, n_secret;
    RAISE NOTICE '% | % | % | %', r.table_name, r.column_name, n_total, n_secret;
  END LOOP;
END $$;
