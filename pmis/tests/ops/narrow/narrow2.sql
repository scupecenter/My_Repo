\set ON_ERROR_STOP 1
SET client_min_messages = warning;
BEGIN;
SET LOCAL session_replication_role = replica;
-- clone the procurement entity into region 2 on another day
INSERT INTO register_records (id, entity_id, register_key, record_type, site_id, region_id, state, is_current, data, created_by, created_at, source)
SELECT 'b0000000-0000-4000-8000-000000000028', 'b0000000-0000-4000-8000-000000000027', register_key, record_type, site_id, 2, state, is_current, data, created_by, '2026-10-01 10:00+02', source
FROM register_records WHERE id = 'a0000000-0000-4000-8000-000000000028';
CREATE TEMP TABLE pc AS SELECT * FROM procurement_records LIMIT 1;
UPDATE pc SET id = gen_random_uuid(), register_record_id = 'b0000000-0000-4000-8000-000000000028', region_id = 2, pr_no = 'PR-CLONE';
INSERT INTO procurement_records SELECT * FROM pc;
RESET session_replication_role;
SAVEPOINT s;
SELECT 'date-oct', (SELECT count(*) FROM register_records WHERE register_key='procurement') b;
SELECT data_reset_use_narrow('{"to":"2026-10-31"}', ARRAY['procurement']) IS NOT NULL;
SELECT 'date-oct', data_reset_core(true,'narrow test reason',NULL,NULL,NULL,ARRAY['procurement'],NULL)->'deleted'->'register_records', (SELECT string_agg(region_id::text, ',') FROM register_records WHERE register_key='procurement') left_regions;
ROLLBACK TO s;
SAVEPOINT s;
SELECT 'date-nov', (SELECT count(*) FROM register_records WHERE register_key='procurement') b;
SELECT data_reset_use_narrow('{"from":"2026-11-01"}', ARRAY['procurement']) IS NOT NULL;
SELECT 'date-nov', data_reset_core(true,'narrow test reason',NULL,NULL,NULL,ARRAY['procurement'],NULL)->'deleted'->'register_records', (SELECT string_agg(region_id::text, ',') FROM register_records WHERE register_key='procurement') left_regions;
ROLLBACK TO s;
SAVEPOINT s;
SELECT 'both', (SELECT count(*) FROM register_records WHERE register_key='procurement') b;
SELECT data_reset_use_narrow('{"regions":[2],"from":"2026-11-01"}', ARRAY['procurement']) IS NOT NULL;
SELECT 'both', data_reset_core(true,'narrow test reason',NULL,NULL,NULL,ARRAY['procurement'],NULL)->'deleted'->'register_records', (SELECT string_agg(region_id::text, ',') FROM register_records WHERE register_key='procurement') left_regions;
ROLLBACK TO s;
SAVEPOINT s;
SELECT 'region1+oct', (SELECT count(*) FROM register_records WHERE register_key='procurement') b;
SELECT data_reset_use_narrow('{"regions":[1],"to":"2026-10-31"}', ARRAY['procurement']) IS NOT NULL;
SELECT 'region1+oct', data_reset_core(true,'narrow test reason',NULL,NULL,NULL,ARRAY['procurement'],NULL)->'deleted'->'register_records', (SELECT string_agg(region_id::text, ',') FROM register_records WHERE register_key='procurement') left_regions;
ROLLBACK TO s;
SELECT 'err-part'; SAVEPOINT e; SELECT data_reset_use_narrow('{"regions":[1]}', ARRAY['sites']); ROLLBACK TO e;
ROLLBACK;
