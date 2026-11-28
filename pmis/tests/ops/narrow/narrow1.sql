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
SELECT 'before', (SELECT count(*) FROM register_records WHERE register_key='procurement'), (SELECT count(*) FROM procurement_records);
SELECT data_reset_use_narrow('{"regions":[1]}', ARRAY['procurement']) IS NOT NULL AS narrowed;
SELECT 'dry', e->>'tbl', e->>'rows', e->>'delete', e->>'keep' FROM jsonb_array_elements(data_reset_core(false,NULL,NULL,NULL,NULL,ARRAY['procurement'],NULL)->'plan') e WHERE (e->>'delete')::int > 0 OR e->>'tbl' IN ('procurement_records','register_records');
SELECT 'scope', data_reset_scope_json(ARRAY['procurement'])::text;
SELECT 'exec', data_reset_core(true,'narrow test reason',NULL,NULL,NULL,ARRAY['procurement'],NULL)->'deleted';
SELECT 'after', (SELECT count(*) FROM register_records WHERE register_key='procurement'), (SELECT count(*) FROM procurement_records), (SELECT region_id FROM register_records WHERE register_key='procurement');
ROLLBACK;
