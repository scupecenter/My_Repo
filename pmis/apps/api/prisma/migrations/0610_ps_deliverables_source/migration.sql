-- 0610_ps_deliverables_source (contract 0.15.470): the Project Status items HLD, DOC, NMS-S, BILL, PILOT, NMS-I, NMS-A and TRN can read their figure from
-- the Deliverables register (F4 follow-up 1: accepted share of non-cancelled deliverables, manual value kept
-- with its history, mapping and mode in Settings, a switch per item "auto" or "manual only", the dashboard shows the source).
-- Mirror: db/sql/609_ps_deliverables_source.sql (kept byte-identical to prisma/migrations/0610_ps_deliverables_source/migration.sql).
--
--   * The mapping is the setting dashboard.ps_deliverables ({"items": {"<item code>": {"kind": "<DeliverableKind code>", "mode": "auto" | "manual"}}}).
--     Without a saved row the defaults below apply (1.3 HLD, 1.5 DOC, 3.8 NMS-S, 3.10 BILL, 6.1 PILOT, 6.6 NMS-I, 7.7 NMS-A, 8.1 TRN) and every item is "auto".
--   * A mapped item in mode "auto" takes its figure from the register while at least one non-cancelled deliverable of its kind exists:
--     accepted / non-cancelled, counted over the current approved records approved on or before the reference date (and, for a saved snapshot, before the
--     snapshot was taken). With no deliverable of the kind the item falls back to its manual value, exactly as before. Mode "manual" never reads the register.
--   * ps_manual_values is never touched: the manual entries stay with their full history and come back the moment an item is set to "manual".
--   * dash_build_manual is patched in place (idempotent): _dman gets src ('manual' | 'deliverables') and the counts dacc / dtot; dash_ps_card adds
--     manual.source and manual.deliverables so the dashboard can show where a number comes from.
--   * ps_deliverables_json() reads the mapping with the live counts; admin_save_ps_deliverables(items, reason, version) writes it: admin.settings edit for
--     all regions, reason, If-Match, one audit row ps_deliverables_update with before and after. No new table (so no data reset change), no permission change.

CREATE OR REPLACE FUNCTION ps_deliv_map() RETURNS TABLE (item text, kind text, mode text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH d(item, kind) AS (VALUES ('1.3', 'HLD'), ('1.5', 'DOC'), ('3.8', 'NMS-S'), ('3.10', 'BILL'), ('6.1', 'PILOT'), ('6.6', 'NMS-I'), ('7.7', 'NMS-A'), ('8.1', 'TRN')),
  s AS (SELECT e.key AS item, e.value ->> 'kind' AS kind, e.value ->> 'mode' AS mode
        FROM jsonb_each(coalesce((SELECT v.value -> 'items' FROM public.settings v WHERE v.key = 'dashboard.ps_deliverables' AND jsonb_typeof(v.value -> 'items') = 'object'), '{}'::jsonb)) e
        WHERE jsonb_typeof(e.value) = 'object')
  SELECT coalesce(s.item, d.item), CASE WHEN s.item IS NOT NULL THEN s.kind ELSE d.kind END, coalesce(s.mode, 'auto')
  FROM d FULL JOIN s ON s.item = d.item
$$;

-- The accepted and the non-cancelled counts of a kind on a reference date (current approved records only).
CREATE OR REPLACE FUNCTION ps_deliv_counts(p_kind text, p_ref date, p_known timestamptz) RETURNS TABLE (accepted integer, total integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT count(*) FILTER (WHERE r.data ->> 'deliverable_state' = 'Accepted'
                            AND (coalesce(r.data ->> 'accepted_date', '') = '' OR (r.data ->> 'accepted_date')::date <= p_ref))::int,
         count(*)::int
  FROM public.register_records r
  WHERE r.register_key = 'deliverables' AND r.is_current AND r.state = 'approved' AND r.approved_at IS NOT NULL
    AND r.data ->> 'deliverable_kind' = p_kind AND coalesce(r.data ->> 'deliverable_state', '') <> 'Cancelled'
    AND r.approved_at::date <= p_ref AND (p_known IS NULL OR r.approved_at <= p_known)
$$;

-- dash_build_manual: the register figure replaces the manual figure of a mapped "auto" item that has deliverables.
DO $$
DECLARE def text;
  m_sel text := E'SELECT DISTINCT ON (v.item_code) v.item_code AS item, v.value_pct / 100.0 AS pct, v.value_pct, v.effective_date, v.version';
  m_idx text := E'  CREATE UNIQUE INDEX ON _dman (item);';
BEGIN
  def := pg_get_functiondef('public.dash_build_manual(date,timestamptz)'::regprocedure);
  IF position('_dman' IN def) > 0 AND position('ps_deliv_map' IN def) = 0 THEN
    IF position(m_sel IN def) = 0 THEN RAISE EXCEPTION 'dash_build_manual() has no select anchor to patch'; END IF;
    IF position(m_idx IN def) = 0 THEN RAISE EXCEPTION 'dash_build_manual() has no index anchor to patch'; END IF;
    def := replace(def, m_sel, m_sel || E', ''manual''::text AS src, NULL::int AS dacc, NULL::int AS dtot');
    def := replace(def, m_idx,
      E'  -- 0610: a mapped item in mode auto reads the Deliverables register (accepted / non-cancelled) while deliverables of its kind exist.\n'
      || E'  DELETE FROM _dman d USING public.ps_deliv_map() mp, LATERAL public.ps_deliv_counts(mp.kind, p_ref, p_known) c\n'
      || E'    WHERE d.item = mp.item AND mp.mode = ''auto'' AND mp.kind IS NOT NULL AND c.total > 0;\n'
      || E'  INSERT INTO _dman (item, pct, value_pct, effective_date, version, src, dacc, dtot)\n'
      || E'    SELECT mp.item, c.accepted::numeric / c.total, round(c.accepted::numeric * 100 / c.total, 3), p_ref, 0, ''deliverables'', c.accepted, c.total\n'
      || E'    FROM public.ps_deliv_map() mp, LATERAL public.ps_deliv_counts(mp.kind, p_ref, p_known) c\n'
      || E'    WHERE mp.mode = ''auto'' AND mp.kind IS NOT NULL AND c.total > 0;\n'
      || m_idx);
    EXECUTE def;
  END IF;
END $$;

-- dash_ps_card: the manual block of an item says where the figure comes from.
DO $$
DECLARE def text;
  m_col text := E'm.version AS mver,';
  m_js text := E'''effective_date'', i.meff, ''version'', i.mver)';
BEGIN
  def := pg_get_functiondef('public.dash_ps_card(boolean,jsonb)'::regprocedure);
  IF position('msrc' IN def) = 0 THEN
    IF position(m_col IN def) = 0 THEN RAISE EXCEPTION 'dash_ps_card() has no mver anchor to patch'; END IF;
    IF position(m_js IN def) = 0 THEN RAISE EXCEPTION 'dash_ps_card() has no manual-json anchor to patch'; END IF;
    def := replace(def, m_col, E'm.version AS mver, m.src AS msrc, m.dacc AS mdacc, m.dtot AS mdtot,');
    def := replace(def, m_js, E'''effective_date'', i.meff, ''version'', i.mver, ''source'', i.msrc, ''deliverables'', CASE WHEN i.msrc = ''deliverables'' THEN jsonb_build_object(''accepted'', i.mdacc, ''total'', i.mdtot) END)');
    EXECUTE def;
  END IF;
END $$;

-- Reader: the central manual items in force with their mapping, mode and the live counts.
CREATE OR REPLACE FUNCTION ps_deliverables_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s record; items jsonb;
BEGIN
  SELECT value, updated_at, updated_by INTO s FROM public.settings WHERE key = 'dashboard.ps_deliverables';
  SELECT coalesce(jsonb_agg(jsonb_build_object('item_code', c.item_code, 'name_en', c.name_en, 'name_ar', c.name_ar, 'weight', c.weight,
           'kind', mp.kind, 'mode', coalesce(mp.mode, 'manual'), 'accepted', k.accepted, 'total', k.total,
           'source', CASE WHEN coalesce(mp.mode, 'manual') = 'auto' AND mp.kind IS NOT NULL AND coalesce(k.total, 0) > 0 THEN 'deliverables' ELSE 'manual' END)
         ORDER BY c.sort), '[]'::jsonb)
    INTO items
  FROM public.ps_central_items(public.cal_today()) c
  LEFT JOIN public.ps_deliv_map() mp ON mp.item = c.item_code
  LEFT JOIN LATERAL public.ps_deliv_counts(mp.kind, public.cal_today(), NULL) k ON mp.kind IS NOT NULL;
  RETURN jsonb_build_object('items', items,
    'version', CASE WHEN s.updated_by IS NULL THEN 0 ELSE floor(extract(epoch FROM s.updated_at))::int END,
    'updated_at', CASE WHEN s.updated_by IS NULL THEN NULL ELSE s.updated_at END,
    'updated_by', s.updated_by);
END
$$;

-- Writer: p_items is an array of {item_code, kind, mode}. The kind is a DeliverableKind code (required in mode auto); the item is a central manual item in force.
CREATE OR REPLACE FUNCTION admin_save_ps_deliverables(p_items jsonb, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE cur jsonb; before jsonb; after jsonb; errs jsonb := '[]'::jsonb; v int; e jsonb; i int := 0; seen text[] := ARRAY[]::text[]; store jsonb := '{}'::jsonb;
        code text; kind text; mode text;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('dashboard.ps_deliverables', '{"items": {}}', 'F4 follow-up: which Project Status items read the Deliverables register (kind) and in which mode (auto or manual).', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'dashboard.ps_deliverables' FOR UPDATE;
  cur := public.ps_deliverables_json();
  v := (cur ->> 'version')::int;
  IF p_version IS NOT NULL AND p_version <> v THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    errs := errs || public.reg_err_item('/items', 'invalid', 'A list of items.');
  ELSE
    FOR e IN SELECT * FROM jsonb_array_elements(p_items) LOOP
      code := e ->> 'item_code'; kind := nullif(e ->> 'kind', ''); mode := e ->> 'mode';
      IF code IS NULL OR NOT EXISTS (SELECT 1 FROM public.ps_central_items(public.cal_today()) c WHERE c.item_code = code) THEN
        errs := errs || public.reg_err_item('/items/' || i || '/item_code', 'invalid', 'Not a central Project Status item in force.');
      ELSIF code = ANY (seen) THEN
        errs := errs || public.reg_err_item('/items/' || i || '/item_code', 'duplicate', 'The item is listed twice.');
      ELSE
        seen := seen || code;
      END IF;
      IF mode IS NULL OR mode NOT IN ('auto', 'manual') THEN
        errs := errs || public.reg_err_item('/items/' || i || '/mode', 'invalid', 'auto or manual.');
      END IF;
      IF kind IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.list_values lv WHERE lv.catalogue_code = 'DeliverableKind' AND lv.code = kind AND lv.is_active) THEN
        errs := errs || public.reg_err_item('/items/' || i || '/kind', 'invalid', 'Not an active deliverable kind.');
      ELSIF kind IS NULL AND mode = 'auto' THEN
        errs := errs || public.reg_err_item('/items/' || i || '/kind', 'required', 'A deliverable kind is needed in mode auto.');
      END IF;
      IF code IS NOT NULL AND mode IN ('auto', 'manual') THEN
        store := store || jsonb_build_object(code, jsonb_strip_nulls(jsonb_build_object('kind', kind, 'mode', mode)));
      END IF;
      i := i + 1;
    END LOOP;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  before := cur - 'updated_at' - 'updated_by';
  UPDATE public.settings SET value = jsonb_build_object('items', store), updated_by = public.app_actor(), updated_at = clock_timestamp()
   WHERE key = 'dashboard.ps_deliverables';
  after := public.ps_deliverables_json();
  PERFORM public.log_audit_write('ps_deliverables_update', 'setting', 'dashboard.ps_deliverables', before, after - 'updated_at' - 'updated_by', btrim(p_reason));
  RETURN after;
END
$$;

DO $$
DECLARE f text;
  fns text[] := ARRAY['ps_deliv_map()', 'ps_deliv_counts(text,date,timestamptz)', 'ps_deliverables_json()', 'admin_save_ps_deliverables(jsonb,text,integer)'];
BEGIN
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY fns LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
