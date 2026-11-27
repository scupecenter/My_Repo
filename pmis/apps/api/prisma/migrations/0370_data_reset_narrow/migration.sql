-- 0370_data_reset_narrow: the project data reset can be narrowed inside a register part (Data entry proposal P1, approved by the owner 2026-11-27).
-- Mirror: db/sql/369_data_reset_narrow.sql (kept byte-identical). The contract of the reset is docs/ops/data-reset.md.
--
--   A part chosen for reset may be narrowed to the register entities that match ALL of: a region (one or more), the import batch they came from (the
--   historical-direct batch of the record or the batch of its row), and the date the entity was first created (inclusive, Africa/Tripoli calendar days).
--   Inside a register the unit is the ENTITY (every version of a record goes or stays together). The satellite rows of an entity follow it: the specialised
--   register rows (register_record_id), steps, voters, locks, document slots and files, comments, drafts, levels conversions, hlc/PR links, readiness,
--   vehicle reservations. A kept entity keeps everything that hangs off it.
--   Only parts whose every table can follow an entity are narrowable (data_reset_narrowable()); the others are refused with their names, never half done.
--   Parts that depend on a narrowed part (procurement -> car_dispatcher, financial_advances, invoices) take only the entities linked to the selected procurement
--   records (data->>'procurement_record_id' names a record or an entity), plus those that match the filter themselves when the requester ticked them.
--   The narrow filter is part of the scope: scope.narrow, bound by scope_hash and approved_scope_hash like the parts (a CHECK-like guard already makes the
--   scope immutable); an approver who saw another narrowing is refused (409 scope_changed). No new table and no new column.
--   The filter reaches the core, the dry run and the plan through the transaction-local setting pmis.reset_narrow (set by data_reset_use_narrow, the only
--   writer); the stored function texts of data_reset_plan, data_reset_core and data_reset_check_scope are patched in place (idempotent), never rebuilt.

SELECT set_config('app.region_ids', '*', true);

-- 1. The narrowable parts: every table of the part follows an entity (see above). Computed here as a list so the screen and the checks agree.
CREATE OR REPLACE FUNCTION data_reset_narrowable() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT ARRAY['acquisition', 'car_dispatcher', 'deliverables', 'dismantle', 'financial_advances', 'gecol', 'hlc', 'invoices', 'issues', 'permits', 'procurement',
               'readiness', 'rf_design', 'risks']
$$;

-- 2. The filter: normal form, or NULL when there is none. Keys: regions (region ids), batches (import batch ids), from, to (YYYY-MM-DD). At least one.
CREATE OR REPLACE FUNCTION data_reset_narrow_norm(p_narrow jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE regs int[]; bats uuid[]; d_from date; d_to date; k text; bad text;
BEGIN
  IF p_narrow IS NULL OR p_narrow = 'null'::jsonb THEN RETURN NULL; END IF;
  IF jsonb_typeof(p_narrow) <> 'object' THEN
    PERFORM public.data_reset_err(422, 'validation_failed', 'narrow must be an object');
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_narrow) LOOP
    IF k NOT IN ('regions', 'batches', 'from', 'to') THEN
      PERFORM public.data_reset_err(422, 'validation_failed', format('unknown narrow key: %s', left(k, 40)));
    END IF;
  END LOOP;
  BEGIN
    regs := ARRAY(SELECT DISTINCT x::int FROM jsonb_array_elements_text(coalesce(p_narrow -> 'regions', '[]'::jsonb)) x ORDER BY 1);
    bats := ARRAY(SELECT DISTINCT x::uuid FROM jsonb_array_elements_text(coalesce(p_narrow -> 'batches', '[]'::jsonb)) x ORDER BY 1);
    d_from := nullif(p_narrow ->> 'from', '')::date;
    d_to := nullif(p_narrow ->> 'to', '')::date;
  EXCEPTION WHEN others THEN
    PERFORM public.data_reset_err(422, 'validation_failed', 'narrow has a value of the wrong kind (regions: ids, batches: ids, from/to: YYYY-MM-DD)');
  END;
  IF cardinality(regs) > 50 OR cardinality(bats) > 50 THEN
    PERFORM public.data_reset_err(422, 'validation_failed', 'at most 50 regions and 50 batches');
  END IF;
  IF cardinality(regs) = 0 AND cardinality(bats) = 0 AND d_from IS NULL AND d_to IS NULL THEN RETURN NULL; END IF;
  IF d_from IS NOT NULL AND d_to IS NOT NULL AND d_from > d_to THEN
    PERFORM public.data_reset_err(422, 'validation_failed', 'the period starts after it ends');
  END IF;
  SELECT string_agg(x::text, ', ') INTO bad FROM unnest(regs) x WHERE NOT EXISTS (SELECT 1 FROM public.regions r WHERE r.id = x);
  IF bad IS NOT NULL THEN PERFORM public.data_reset_err(422, 'validation_failed', format('unknown region: %s', bad)); END IF;
  SELECT string_agg(x::text, ', ') INTO bad FROM unnest(bats) x WHERE NOT EXISTS (SELECT 1 FROM public.import_batches b WHERE b.id = x);
  IF bad IS NOT NULL THEN PERFORM public.data_reset_err(422, 'validation_failed', format('unknown import batch: %s', bad)); END IF;
  RETURN jsonb_strip_nulls(jsonb_build_object('version', 1, 'regions', to_jsonb(regs), 'batches', to_jsonb(bats), 'from', d_from, 'to', d_to));
END $$;

-- 3. The only writer of the transaction-local filter. Needs a list of parts (a narrowed "everything" is refused) whose closure is narrowable.
CREATE OR REPLACE FUNCTION data_reset_use_narrow(p_narrow jsonb, p_parts text[]) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE n jsonb := public.data_reset_narrow_norm(p_narrow); c text[]; bad text;
BEGIN
  IF n IS NOT NULL THEN
    IF p_parts IS NULL THEN
      PERFORM public.data_reset_err(422, 'validation_failed', 'a narrowing needs chosen parts, not everything');
    END IF;
    c := public.data_reset_closure(p_parts);
    SELECT string_agg(x, ', ' ORDER BY x) INTO bad FROM unnest(c) x WHERE x <> ALL (public.data_reset_narrowable());
    IF bad IS NOT NULL THEN
      PERFORM public.data_reset_err(422, 'validation_failed', format('these parts cannot be narrowed (their data does not follow a single register record): %s', bad));
    END IF;
  END IF;
  PERFORM set_config('pmis.reset_narrow', coalesce(n::text, ''), true);
  RETURN n;
END $$;

-- The filter of this transaction (NULL: none).
CREATE OR REPLACE FUNCTION data_reset_narrow() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT nullif(current_setting('pmis.reset_narrow', true), '')::jsonb
$$;

-- The binding hash with the filter (no filter: the hash is the old one, so every earlier request keeps its hash).
CREATE OR REPLACE FUNCTION data_reset_scope_hash_n(p_closure text[]) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN public.data_reset_narrow() IS NULL THEN public.data_reset_scope_hash(p_closure)
    ELSE encode(sha256(convert_to('pmis-data-reset-scope:4:narrow:' || array_to_string(ARRAY(SELECT x FROM unnest(p_closure) x ORDER BY x), ',') || ':'
                                  || public.data_reset_narrow()::text, 'UTF8')), 'hex') END
$$;

-- request_hash(closure, require_backup): with a filter the backup-choice variant also covers it.
CREATE OR REPLACE FUNCTION data_reset_request_hash(p_closure text[], p_require_backup boolean) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN p_require_backup IS NOT FALSE THEN public.data_reset_scope_hash_n(p_closure)
    WHEN public.data_reset_narrow() IS NULL THEN
      encode(sha256(convert_to('pmis-data-reset-scope:2:no-backup:' || array_to_string(ARRAY(SELECT x FROM unnest(p_closure) x ORDER BY x), ','), 'UTF8')), 'hex')
    ELSE encode(sha256(convert_to('pmis-data-reset-scope:4:no-backup:' || array_to_string(ARRAY(SELECT x FROM unnest(p_closure) x ORDER BY x), ',') || ':'
                                  || public.data_reset_narrow()::text, 'UTF8')), 'hex') END
$$;

-- scope_json: the same document plus scope.narrow, and the hash with the filter.
CREATE OR REPLACE FUNCTION data_reset_scope_json(p_parts text[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c text[] := public.data_reset_closure(p_parts); req text[];
BEGIN
  req := CASE WHEN p_parts IS NULL THEN c ELSE ARRAY(SELECT DISTINCT x FROM unnest(p_parts) x ORDER BY x) END;
  RETURN jsonb_build_object('version', 1, 'requested', to_jsonb(req), 'parts', to_jsonb(c),
    'added', to_jsonb(ARRAY(SELECT x FROM unnest(c) x WHERE x <> ALL (req) ORDER BY x)),
    'everything', c @> public.data_reset_project_parts() AND public.data_reset_narrow() IS NULL,
    'identity', to_jsonb(ARRAY(SELECT x FROM unnest(c) x WHERE x IN ('users', 'roles', 'staff') ORDER BY x)),
    'narrow', public.data_reset_narrow(),
    'hash', public.data_reset_scope_hash_n(c));
END $$;

-- 4. The dry run takes the filter (replaces the one-argument door).
DROP FUNCTION IF EXISTS data_reset_dry_run(text[]);
CREATE OR REPLACE FUNCTION data_reset_dry_run(p_parts text[], p_narrow jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE parts text[];
BEGIN
  PERFORM public.data_reset_require_admin(false);
  parts := public.data_reset_require_parts(p_parts);
  PERFORM public.data_reset_use_narrow(p_narrow, parts);
  RETURN public.data_reset_plan_json(parts);
END $$;

-- 5. The request door takes the filter. Patched in place from the stored text (the previous door is dropped, its identity changes).
DO $$
DECLARE def text; old regprocedure := 'public.admin_data_reset_request(text,text,text[],boolean,text)'::regprocedure; n text;
BEGIN
  def := pg_get_functiondef(old);
  n := 'p_no_backup_confirm text DEFAULT NULL::text)';
  IF position(n IN def) = 0 THEN RAISE EXCEPTION 'admin_data_reset_request: signature not found'; END IF;
  def := replace(def, n, 'p_no_backup_confirm text DEFAULT NULL::text, p_narrow jsonb DEFAULT NULL::jsonb)');
  n := 'parts := public.data_reset_require_parts(p_parts);';
  IF position(n IN def) = 0 THEN RAISE EXCEPTION 'admin_data_reset_request: parts line not found'; END IF;
  def := replace(def, n, n || E'\n  PERFORM public.data_reset_use_narrow(p_narrow, parts);');
  DROP FUNCTION public.admin_data_reset_request(text,text,text[],boolean,text);
  EXECUTE def;
END $$;

-- 6. The scope check restores the filter from the stored scope, and compares the hash with it. Volatile now (it sets the transaction-local filter).
DO $$
DECLARE def text; n text;
BEGIN
  def := pg_get_functiondef('public.data_reset_check_scope(public.data_reset_requests,text)'::regprocedure);
  IF position('data_reset_use_narrow' IN def) = 0 THEN
    n := 'c := public.data_reset_closure(r.requested_parts);';
    IF position(n IN def) = 0 THEN RAISE EXCEPTION 'data_reset_check_scope: closure line not found'; END IF;
    def := replace(def, n, E'PERFORM public.data_reset_use_narrow(r.scope -> ''narrow'', r.requested_parts);\n  ' || n);
    n := 'public.data_reset_scope_hash(c)';
    IF position(n IN def) = 0 THEN RAISE EXCEPTION 'data_reset_check_scope: hash call not found'; END IF;
    def := replace(def, n, 'public.data_reset_scope_hash_n(c)');
    def := replace(def, E'\n STABLE SECURITY DEFINER', E'\n SECURITY DEFINER');
    EXECUTE def;
  END IF;
END $$;

-- 7. The plan: the satellite rows of a register entity follow the entity (the old rows took the whole part). With no filter the result is the same: the
-- entity of a register of the part has the part. A row without a link to a record goes with the part when nothing is narrowed and stays when it is.
DO $$
DECLARE def text; r record; old text; new text; n int := 0;
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('reset_narrow_applied' IN def) = 0 THEN
    FOR r IN SELECT * FROM (VALUES
      ('procurement_records', 'procurement', 'rec', 'register_record_id'), ('gecol_records', 'gecol', 'rec', 'register_record_id'),
      ('hlc_records', 'hlc', 'rec', 'register_record_id'), ('permit_records', 'permits', 'rec', 'register_record_id'),
      ('issues', 'issues', 'rec', 'register_record_id'), ('risks', 'risks', 'rec', 'register_record_id'),
      ('readiness_handover', 'readiness', 'rec', 'register_record_id'), ('rf_design_records', 'rf_design', 'rec', 'register_record_id'),
      ('acquisition_candidates', 'acquisition', 'rec', 'register_record_id'), ('hlc_legacy_migrations', 'hlc', 'rec', 'hlc_record_id'),
      ('vehicle_reservations', 'car_dispatcher', 'rec', 'booking_record_id'), ('assignment_readiness', 'procurement', 'ent', 'procurement_entity_id')
    ) v(tbl, part, kind, col) LOOP
      old := format($q$(%L, 'delete', %L, 'ARRAY[''%s'']')$q$, r.tbl, r.part, r.part);
      IF position(old IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan: row of % not found', r.tbl; END IF;
      new := format($q$(%L, 'delete', %L, 'coalesce((SELECT x.parts FROM pg_temp.%s x WHERE x.%s = t.%s), CASE WHEN public.data_reset_narrow() IS NULL THEN ARRAY[''%s''] ELSE ''{}''::text[] END)')$q$,
                    r.tbl, r.part, CASE r.kind WHEN 'rec' THEN 'reset_rec' ELSE 'reset_ent' END, CASE r.kind WHEN 'rec' THEN 'id' ELSE 'entity_id' END, r.col, r.part);
      def := replace(def, old, new); n := n + 1;
    END LOOP;
    -- the HLC/PR link: the procurement side follows the procurement entity when narrowed
    old := $q$|| ARRAY[''procurement'']'),$q$;
    IF position(old IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan: hlc_pr_links tail not found'; END IF;
    def := replace(def, old, $q$|| CASE WHEN public.data_reset_narrow() IS NULL THEN ARRAY[''procurement''] ELSE coalesce((SELECT e.parts FROM pg_temp.reset_ent e WHERE e.entity_id = t.procurement_entity_id), ''{}''::text[]) END'),$q$);
    -- follows of a kept register entity stay when narrowed
    old := $q$'ARRAY[''notifications'', ''sites''] || CASE$q$;
    IF position(old IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan: watches row not found'; END IF;
    def := replace(def, old, $q$'CASE WHEN public.data_reset_narrow() IS NOT NULL AND EXISTS (SELECT 1 FROM pg_temp.reset_ent e WHERE e.entity_id = t.entity_id AND e.kept) THEN ''{}''::text[] ELSE ARRAY[''notifications'', ''sites''] END || CASE$q$);
    -- marker so the patch is not applied twice
    def := replace(def, E'\n  SELECT t, ''keep'', NULL::text,', E'\n  -- reset_narrow_applied (0370)\n  SELECT t, ''keep'', NULL::text,');
    EXECUTE def;
  END IF;
END $$;

-- 8. The core: after the register entities are known, narrow them to the filter; the rest follows (slots, files, comments, drafts, batches...).
DO $$
DECLARE def text; n text; blk text;
BEGIN
  def := pg_get_functiondef('public.data_reset_core(boolean,text,jsonb,uuid,uuid,text[],uuid[])'::regprocedure);
  IF position('reset_sel' IN def) = 0 THEN
    n := E'ALTER TABLE pg_temp.reset_ent ADD PRIMARY KEY (entity_id);\n';
    IF position(n IN def) = 0 THEN RAISE EXCEPTION 'data_reset_core: reset_ent key line not found'; END IF;
    blk := $b$
  -- NARROW (0370): a filter keeps every register entity that does not match it (parts {}, kept): its rows, steps, slots, files, comments and drafts stay.
  -- Selected: the entities of the requested parts that match ALL of the filter (region, import batch, first-created day); plus the entities of the parts
  -- the closure added (dependents of procurement) that are linked to a selected procurement record or entity (data->>'procurement_record_id').
  IF public.data_reset_narrow() IS NOT NULL THEN
    DECLARE nj jsonb := public.data_reset_narrow(); req text[] := ARRAY(SELECT DISTINCT x FROM unnest(p_parts) x);
            f_regs int[]; f_bats uuid[]; f_from date; f_to date;
    BEGIN
      IF p_parts IS NULL OR NOT (scope <@ public.data_reset_narrowable()) THEN
        RAISE EXCEPTION 'reset-project-data: a narrowing needs chosen narrowable parts, nothing was reset';
      END IF;
      f_regs := ARRAY(SELECT x::int FROM jsonb_array_elements_text(coalesce(nj -> 'regions', '[]'::jsonb)) x);
      f_bats := ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(coalesce(nj -> 'batches', '[]'::jsonb)) x);
      f_from := (nj ->> 'from')::date; f_to := (nj ->> 'to')::date;
      CREATE TEMP TABLE reset_sel ON COMMIT DROP AS
        SELECT e.entity_id FROM pg_temp.reset_ent e
        WHERE NOT e.kept AND e.parts && req
          AND EXISTS (SELECT 1 FROM public.register_records rr WHERE rr.entity_id = e.entity_id
                        AND (cardinality(f_regs) = 0 OR rr.region_id = ANY (f_regs))
                        AND (cardinality(f_bats) = 0 OR rr.historical_direct_batch_id = ANY (f_bats)
                             OR rr.batch_row_id IN (SELECT ibr.id FROM public.import_batch_rows ibr WHERE ibr.batch_id = ANY (f_bats))))
          AND (f_from IS NULL OR (SELECT (min(rr.created_at) AT TIME ZONE 'Africa/Tripoli')::date FROM public.register_records rr WHERE rr.entity_id = e.entity_id) >= f_from)
          AND (f_to IS NULL OR (SELECT (min(rr.created_at) AT TIME ZONE 'Africa/Tripoli')::date FROM public.register_records rr WHERE rr.entity_id = e.entity_id) <= f_to);
      INSERT INTO pg_temp.reset_sel
        SELECT e.entity_id FROM pg_temp.reset_ent e
        WHERE NOT e.kept AND e.parts && ARRAY(SELECT x FROM unnest(scope) x WHERE x <> ALL (req))
          AND e.entity_id NOT IN (SELECT s.entity_id FROM pg_temp.reset_sel s)
          AND EXISTS (SELECT 1 FROM public.register_records rr WHERE rr.entity_id = e.entity_id AND (rr.data ->> 'procurement_record_id') IN (
                SELECT k FROM (SELECT pr.id::text AS k FROM public.register_records pr JOIN pg_temp.reset_sel s ON s.entity_id = pr.entity_id
                               JOIN pg_temp.reset_ent pe ON pe.entity_id = pr.entity_id AND pe.parts && ARRAY['procurement']
                               UNION SELECT s.entity_id::text FROM pg_temp.reset_sel s JOIN pg_temp.reset_ent pe ON pe.entity_id = s.entity_id AND pe.parts && ARRAY['procurement']) z));
      UPDATE pg_temp.reset_ent e SET parts = '{}'::text[], kept = true
      WHERE NOT e.kept AND e.parts && scope AND e.entity_id NOT IN (SELECT s.entity_id FROM pg_temp.reset_sel s);
    END;
  END IF;
$b$;
    def := replace(def, n, n || blk);
    n := 'pg_temp.reset_ent, pg_temp.reset_keep_users;';
    IF position(n IN def) = 0 THEN RAISE EXCEPTION 'data_reset_core: dry-run drop not found'; END IF;
    def := replace(def, n, n || E'\n    DROP TABLE IF EXISTS pg_temp.reset_sel;');
    n := 'pg_temp.reset_keep_users, pg_temp.reset_sessions;';
    IF position(n IN def) = 0 THEN RAISE EXCEPTION 'data_reset_core: final drop not found'; END IF;
    def := replace(def, n, n || E'\n  DROP TABLE IF EXISTS pg_temp.reset_sel;');
    EXECUTE def;
  END IF;
END $$;

-- 9. The plan JSON: the filter of the scope and, per part, whether it can be narrowed (the screen shows the choice only for those).
DO $$
DECLARE def text; n text;
BEGIN
  def := pg_get_functiondef('public.data_reset_plan_json(text[])'::regprocedure);
  IF position('data_reset_narrowable' IN def) = 0 THEN
    n := '''requested'', p.code = ANY (req)';
    IF position(n IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan_json: requested key not found'; END IF;
    def := replace(def, n, '''narrowable'', p.code = ANY (public.data_reset_narrowable()), ' || n);
    n := E'RETURN jsonb_build_object(\n    ''scope'', sj,';
    IF position(n IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan_json: scope key not found'; END IF;
    def := replace(def, n, E'RETURN jsonb_build_object(\n    ''scope'', sj, ''narrow'', public.data_reset_narrow(),');
    EXECUTE def;
  END IF;
END $$;

-- 10. What the picker offers: regions and recent import batches (a batch of the register the part belongs to, newest first). Counts are live.
CREATE OR REPLACE FUNCTION data_reset_narrow_options(p_part text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.data_reset_require_admin(false);
  IF p_part IS NOT NULL AND p_part <> ALL (public.data_reset_narrowable()) THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/part', 'not_narrowable', 'This part cannot be narrowed.')));
  END IF;
  RETURN jsonb_build_object(
    'narrowable', to_jsonb(public.data_reset_narrowable()),
    'regions', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'code', r.code, 'name_en', r.name_en, 'name_ar', r.name_ar) ORDER BY r.id), '[]'::jsonb) FROM public.regions r),
    'batches', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'file_name', x.file_name, 'register_key', x.register_key, 'rows_total', x.rows_total,
                  'status', x.status, 'created_at', x.created_at, 'historical_load', x.historical_load) ORDER BY x.created_at DESC), '[]'::jsonb)
                FROM (SELECT b.* FROM public.import_batches b
                      WHERE p_part IS NULL OR public.data_reset_register_part(b.register_key) = p_part
                         OR EXISTS (SELECT 1 FROM public.register_records rr WHERE rr.historical_direct_batch_id = b.id AND public.data_reset_register_part(rr.register_key) = p_part)
                      ORDER BY b.created_at DESC LIMIT 200) x));
END $$;

-- 11. Owners and rights (as 0152 gave the family).
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['data_reset_narrowable()', 'data_reset_narrow_norm(jsonb)', 'data_reset_use_narrow(jsonb,text[])', 'data_reset_narrow()',
                           'data_reset_scope_hash_n(text[])'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_reset_owner', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_reset_owner, pmis_definer, pmis_identity_owner', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['data_reset_dry_run(text[],jsonb)', 'admin_data_reset_request(text,text,text[],boolean,text,jsonb)', 'data_reset_narrow_options(text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f); END IF;
  END LOOP;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('data_reset_narrow_applied', 'workflow', NULL,
        jsonb_build_object('narrowable', to_jsonb(data_reset_narrowable()), 'filter', 'regions, import batches, first-created period (all must match)',
                           'binding', 'scope.narrow inside scope_hash and approved_scope_hash; the scope is immutable',
                           'doors', 'data_reset_dry_run(parts, narrow), admin_data_reset_request(..., narrow), data_reset_narrow_options(part)'),
        'Narrowing the project data reset to region, batch or period (migration 0370, Data entry proposal P1).');
