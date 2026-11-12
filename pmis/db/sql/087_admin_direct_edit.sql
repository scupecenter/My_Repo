-- 0088_admin_direct_edit: owner decision 2026-11-12 (2): direct admin edit of site data and of task dates. Contract 0.15.6, CHANGELOG 130.
-- Mirror: db/sql/087_admin_direct_edit.sql (kept byte-identical).
--
-- WHY. Until now a site's identity changed only through a Change Control proposal (0071, Q473) and PATCH /sites/{id} wrote custom values only; the contract defined
-- POST /tasks/{task_id}/overrides and POST /overrides/{id}/revert but nothing implemented them. The owner: a System Admin edits any site field and any task date
-- immediately, with a reason and a step-up, audited with before and after values, shown as "Admin override", reversible. Non-admins keep the proposal path.
--
-- WHAT THIS ADDS.
--   1. admin_overrides: one row per admin edit (entity 'site' or 'task'): kind, reason, before and after, who, when, and the revert (when, who, why). Written only by the
--      functions below (owner pmis_definer); pmis_app has no right on it (db/sql/app_grants.sql) and reads it through the *_json functions.
--   2. site_admin_edit(site, seen, patch, reason): a System Admin (never a delegate) with a step-up edits, at once, the English and Arabic names, the coordinates (a pair,
--      or both cleared), the region and the cluster, the delivery scenario, the six scope flags and any active custom field. The Site ID never changes (field error
--      immutable). The values are checked by the same parsers as a Change Control change (p4a_site_parse, so the same field errors); the scope and scenario conflict
--      rule (Q3) and the applicability of the tasks run as they do when an approved change is applied; the site is recalculated (calc_refresh_site). One audit row with
--      the admin-override flag holds the before and after of every field touched (a region move writes the second row for the old region, as 0071 does).
--   3. task_override_create(task, version, kind, reason, date_field, new_date): kind edit_date for a System Admin with a step-up: actual_start, actual_date,
--      planned_date or baseline_date of a task in any state but N/A and skipped, an approved task included. The task is flagged admin_override (the existing column:
--      the "Admin override" badge, and the KPIs leave it out of SLA and on-time figures while exclude_overrides is on, and count it in override_flagged_count). The SLA of
--      the task follows the new dates (start event re-resolved for actual_start, elapsed days of an approved task recomputed) and the site is recalculated. A calculated
--      milestone that is flagged is not recomputed (calc_refresh_site already skips an approved milestone with admin_override). The other kinds of the contract
--      (unlock, skip, mark_na, accept_without_document, accept_without_workflow, reopen, reassign) are not built here: 422 not_supported on /kind.
--   4. admin_override_revert(id, reason): a System Admin with a step-up puts the old value back, for a task date or for a site edit, only while the field still holds the
--      value the override set (else 409 override_not_revertible, the task or the site moved on since); the flag of the task goes off when no other override of it is left.
--      The history of the task shows 'admin_override' and the new action 'override_revert'.
--   5. task_overrides_json(task), site_admin_edits_json(site): what the screens read (visible regions only).
--
-- Every function: SECURITY DEFINER, search_path = pg_catalog, public, pg_temp, owner pmis_definer, PUBLIC revoked; pmis_app gets only the doors (site_admin_edit,
-- task_override_create, admin_override_revert, task_overrides_json, site_admin_edits_json). The actor comes from app_actor() only.

ALTER TYPE "WorkflowAction" ADD VALUE IF NOT EXISTS 'override_revert';

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE admin_overrides (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity         text NOT NULL CHECK (entity IN ('site', 'task')),
  site_id        uuid NOT NULL REFERENCES sites (id),
  task_id        uuid REFERENCES task_instances (id),
  kind           text NOT NULL,
  reason         text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 2000),
  before         jsonb NOT NULL,
  after          jsonb NOT NULL,
  acted_by       uuid NOT NULL REFERENCES users (id),
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  reverted_at    timestamptz,
  reverted_by    uuid REFERENCES users (id),
  revert_reason  text,
  CONSTRAINT admin_overrides_entity_check CHECK ((entity = 'task') = (task_id IS NOT NULL)),
  CONSTRAINT admin_overrides_revert_check CHECK ((reverted_at IS NULL) = (reverted_by IS NULL))
);
CREATE INDEX admin_overrides_task_idx ON admin_overrides (task_id, created_at DESC) WHERE task_id IS NOT NULL;
CREATE INDEX admin_overrides_site_idx ON admin_overrides (site_id, created_at DESC);
COMMENT ON TABLE admin_overrides IS '0088: direct admin edits of a site (entity site) and admin date overrides of a task (entity task), with the revert. Written only by site_admin_edit, task_override_create and admin_override_revert; no right for pmis_app.';
ALTER TABLE admin_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_overrides FORCE ROW LEVEL SECURITY;   -- no policy: only the definer functions (pmis_definer bypasses row security) read and write it
REVOKE ALL ON admin_overrides FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON admin_overrides TO pmis_definer;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN REVOKE ALL ON admin_overrides FROM pmis_app; END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------------------------------------------------------
-- A System Admin (a delegate is refused: 403 action_forbidden), the same answer for every site and task, asked before anything else.
CREATE OR REPLACE FUNCTION ao_require_admin() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.app_actor();
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT public.app_actor_is_system_admin() THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail',
      'Only a System Admin edits site data or task dates directly. Everybody else proposes a change through Change Control.'));
  END IF;
  RETURN a;
END $$;

CREATE OR REPLACE FUNCTION ao_require_stepup() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT coalesce(public.app_ctx_stepup(), false) THEN PERFORM public.wf_err('step_up_required'); END IF;
END $$;

CREATE OR REPLACE FUNCTION ao_fail(p_path text, p_code text, p_msg text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', p_path, 'code', p_code, 'message', p_msg))));
END $$;

CREATE OR REPLACE FUNCTION ao_reason(p_reason text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE rs text := btrim(coalesce(p_reason, ''));
BEGIN
  IF char_length(rs) < 3 OR char_length(rs) > 2000 THEN PERFORM public.ao_fail('/reason', 'required', 'A reason of 3 to 2000 characters is required.'); END IF;
  RETURN rs;
END $$;

-- The date of a task field.
CREATE OR REPLACE FUNCTION ao_task_date(p_task uuid, p_field text) RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE p_field WHEN 'actual_start' THEN t.actual_start WHEN 'actual_date' THEN t.actual_date WHEN 'planned_date' THEN t.planned_date WHEN 'baseline_date' THEN t.baseline_date END
  FROM public.task_instances t WHERE t.id = p_task
$$;

-- Does the site or the task still hold what the override set (then it can be put back)?
CREATE OR REPLACE FUNCTION ao_current_matches(p_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE o public.admin_overrides%ROWTYPE; k text; ok boolean := true;
BEGIN
  SELECT * INTO o FROM public.admin_overrides WHERE id = p_id;
  IF NOT FOUND OR o.reverted_at IS NOT NULL THEN RETURN false; END IF;
  FOR k IN SELECT jsonb_object_keys(o.after) LOOP
    IF o.entity = 'task' THEN
      ok := ok AND coalesce(public.ao_task_date(o.task_id, k)::text, '(none)') = coalesce(o.after ->> k, '(none)');
    ELSE
      ok := ok AND coalesce(public.p4a_site_current(o.site_id, k), '(none)') = coalesce(o.after ->> k, '(none)');
    END IF;
  END LOOP;
  RETURN ok;
END $$;

CREATE OR REPLACE FUNCTION ao_override_json(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object('id', o.id, 'entity', o.entity, 'task_id', o.task_id, 'site_id', o.site_id, 'kind', o.kind, 'reason', o.reason, 'before', o.before, 'after', o.after,
    'acted_by_id', o.acted_by, 'created_at', o.created_at, 'reverted_at', o.reverted_at, 'reverted_by_id', o.reverted_by, 'revert_reason', o.revert_reason,
    'revertible', o.reverted_at IS NULL AND public.ao_current_matches(o.id))
  FROM public.admin_overrides o WHERE o.id = p_id
$$;

-- The overrides of a task, newest first (the task must be visible to the caller).
CREATE OR REPLACE FUNCTION task_overrides_json(p_task uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(public.ao_override_json(o.id) ORDER BY o.created_at DESC, o.id), '[]'::jsonb)
  FROM public.admin_overrides o JOIN public.task_instances t ON t.id = o.task_id
  WHERE o.task_id = p_task AND public.app_region_check(t.region_id)
$$;

-- The direct admin edits of a site (the 20 newest) and how many are still in force.
CREATE OR REPLACE FUNCTION site_admin_edits_json(p_site uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object(
    'active_count', (SELECT count(*) FROM public.admin_overrides o WHERE o.site_id = p_site AND o.entity = 'site' AND o.reverted_at IS NULL),
    'items', coalesce((SELECT jsonb_agg(public.ao_override_json(x.id) ORDER BY x.created_at DESC, x.id)
                       FROM (SELECT o.id, o.created_at FROM public.admin_overrides o WHERE o.site_id = p_site AND o.entity = 'site'
                             ORDER BY o.created_at DESC, o.id LIMIT 20) x), '[]'::jsonb))
  WHERE EXISTS (SELECT 1 FROM public.sites s WHERE s.id = p_site AND public.app_region_check(s.region_id))
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Task date overrides
-- ---------------------------------------------------------------------------------------------------------------------
-- After a date moved: the SLA of the task follows (the start event again when the actual start moved; the elapsed days of an approved task), then the site is
-- recalculated (gates, calculated milestones, clocks that wait for a start event).
CREATE OR REPLACE FUNCTION ao_task_recalc(p_task uuid, p_field text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE t public.task_instances%ROWTYPE; r public.sla_rules%ROWTYPE; st date;
BEGIN
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  IF NOT FOUND THEN RETURN; END IF;
  IF t.state NOT IN ('locked', 'na', 'skipped') AND t.sla_rule_id IS NOT NULL THEN
    IF p_field = 'actual_start' THEN
      SELECT * INTO r FROM public.sla_rules WHERE id = t.sla_rule_id;
      st := public.sla_resolve_start(p_task, r.start_ref);
      IF st IS NOT NULL AND st IS DISTINCT FROM t.sla_start_date THEN
        UPDATE public.task_instances SET sla_start_date = st, sla_target_date = public.cal_add_workdays(st, r.min_working_days, r.calendar_id),
          due_date = public.cal_add_workdays(st, r.max_working_days, r.calendar_id) WHERE id = p_task;
      END IF;
    END IF;
    IF t.state = 'approved' THEN PERFORM public.sla_task_close(p_task); END IF;
  END IF;
  PERFORM public.calc_refresh_site(t.site_id);
END $$;

-- Writes one date of a task (internal), with the flag and the version.
CREATE OR REPLACE FUNCTION ao_task_write(p_task uuid, p_field text, p_value date, p_flag boolean) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.task_instances SET
    actual_start = CASE WHEN p_field = 'actual_start' THEN p_value ELSE actual_start END,
    actual_date  = CASE WHEN p_field = 'actual_date'  THEN p_value ELSE actual_date END,
    planned_date = CASE WHEN p_field = 'planned_date' THEN p_value ELSE planned_date END,
    baseline_date = CASE WHEN p_field = 'baseline_date' THEN p_value ELSE baseline_date END,
    admin_override = p_flag, version = version + 1, updated_at = now()
  WHERE id = p_task;
END $$;

-- The history row of an override (internal).
CREATE OR REPLACE FUNCTION ao_task_step(p_task uuid, p_action text, p_note text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE t public.task_instances%ROWTYPE;
BEGIN
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  INSERT INTO public.workflow_steps (task_id, level, action, acted_by, note, admin_override, override_reason, stepup_verified, before_state, after_state, created_at)
  VALUES (p_task, greatest(t.current_level, 1), p_action::public."WorkflowAction", public.app_actor(), left(p_note, 2000), true, left(p_note, 2000), true, t.state, t.state, clock_timestamp());
END $$;

CREATE OR REPLACE FUNCTION task_override_create(p_task uuid, p_version integer, p_kind text, p_reason text, p_date_field text, p_new_date date, p_has_date boolean)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid; t public.task_instances%ROWTYPE; rs text; old_d date; oid uuid; fld text := p_date_field; before_snap jsonb;
BEGIN
  actor := public.ao_require_admin();
  t := public.wf_lock_task(p_task, p_version);
  IF p_kind IS DISTINCT FROM 'edit_date' THEN
    PERFORM public.ao_fail('/kind', 'not_supported', 'Only edit_date is built; the other override kinds are not supported yet.');
  END IF;
  IF fld IS NULL OR fld NOT IN ('actual_start', 'actual_date', 'planned_date', 'baseline_date') THEN
    PERFORM public.ao_fail('/date_field', 'required', 'date_field is actual_start, actual_date, planned_date or baseline_date.');
  END IF;
  IF NOT coalesce(p_has_date, false) THEN PERFORM public.ao_fail('/new_date', 'required', 'new_date is a date, or null to clear the date.'); END IF;
  rs := public.ao_reason(p_reason);
  IF t.state IN ('na', 'skipped') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'A task that is N/A or skipped has no dates to edit.'));
  END IF;
  IF p_new_date IS NOT NULL THEN
    IF p_new_date < DATE '2020-01-01' OR p_new_date > DATE '2035-12-31' THEN
      PERFORM public.ao_fail('/new_date', 'invalid_date', 'The date must be between 2020-01-01 and 2035-12-31.');
    ELSIF fld IN ('actual_start', 'actual_date') AND p_new_date > public.cal_today() THEN
      PERFORM public.ao_fail('/new_date', 'future_date', 'An actual date cannot be in the future.');
    END IF;
  ELSIF fld = 'actual_date' AND t.state = 'approved' THEN
    PERFORM public.ao_fail('/new_date', 'required', 'The actual date of an approved task cannot be cleared.');
  END IF;
  old_d := public.ao_task_date(p_task, fld);
  IF old_d IS NOT DISTINCT FROM p_new_date THEN PERFORM public.ao_fail('/new_date', 'unchanged', 'The task has this date already.'); END IF;
  PERFORM public.ao_require_stepup();
  before_snap := public.wf_snap(p_task);
  PERFORM public.ao_task_write(p_task, fld, p_new_date, true);
  INSERT INTO public.admin_overrides (entity, site_id, task_id, kind, reason, before, after, acted_by)
  VALUES ('task', t.site_id, p_task, 'edit_date', rs, jsonb_build_object(fld, old_d), jsonb_build_object(fld, p_new_date), actor) RETURNING id INTO oid;
  PERFORM public.ao_task_step(p_task, 'admin_override', rs);
  PERFORM public.log_audit_write('task_override_edit_date', 'task', p_task::text, before_snap,
    public.wf_snap(p_task) || jsonb_build_object('override_id', oid, 'date_field', fld, 'admin_override', true), rs, t.site_id, t.region_id, NULL, true);
  PERFORM public.ao_task_recalc(p_task, fld);
  RETURN public.ao_override_json(oid);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Site edits
-- ---------------------------------------------------------------------------------------------------------------------
-- The text of a new value as Change Control would carry it (to compare with the site and to store the clean value).
CREATE OR REPLACE FUNCTION ao_norm(p_item text, p_v jsonb) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE
    WHEN p_item = 'site.coordinates' AND (p_v ->> 'latitude') IS NULL THEN '(none)'
    WHEN p_item = ANY (public.si_identity_items()) THEN public.si_parsed_text(p_item, p_v)
    WHEN p_item LIKE 'site.custom.%' THEN public.p4a_site_value_text(p_v)
    WHEN p_item LIKE 'site.scope_%' THEN CASE p_v #>> '{}' WHEN 'yes' THEN 'Yes' WHEN 'na' THEN 'N/A' ELSE '(none)' END
    ELSE p_v #>> '{}' END
$$;

-- Parses one item (the Change Control parsers; the coordinates may also be cleared, as a pair). Raises the field error of the parser.
CREATE OR REPLACE FUNCTION ao_parse(p_site uuid, p_item text, p_text text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_item = 'site.coordinates' AND lower(btrim(coalesce(p_text, ''))) IN ('(none)', ', ') THEN
    RETURN jsonb_build_object('latitude', NULL, 'longitude', NULL);
  END IF;
  RETURN public.p4a_site_parse(p_site, p_item, p_text);
END $$;

-- Checks one item for the API patch: {errors, cur, norm}. p_base and p_key name the request field in the errors (/identity/name, /custom/near_airport, /scenario).
CREATE OR REPLACE FUNCTION ao_check_item(p_site uuid, p_item text, p_text text, p_base text, p_key text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v jsonb; cur text := coalesce(public.p4a_site_current(p_site, p_item), '(none)'); msg text; errs jsonb;
BEGIN
  BEGIN
    v := public.ao_parse(p_site, p_item, p_text);
  EXCEPTION WHEN raise_exception THEN
    msg := SQLERRM;
    IF msg NOT LIKE 'wf:validation_failed:%' THEN RAISE; END IF;
    errs := (substr(msg, 22)::jsonb) -> 'errors';
    SELECT jsonb_agg(jsonb_set(x, '{path}', to_jsonb(
      CASE WHEN x ->> 'path' LIKE '/data/new_value/%' THEN p_base || '/' || substr(x ->> 'path', 17) ELSE p_base || CASE WHEN p_key = '' THEN '' ELSE '/' || p_key END END)))
      INTO errs FROM jsonb_array_elements(errs) x;
    RETURN jsonb_build_object('errors', coalesce(errs, '[]'::jsonb), 'cur', cur);
  END;
  RETURN jsonb_build_object('errors', '[]'::jsonb, 'cur', cur, 'norm', public.ao_norm(p_item, v));
END $$;

-- Applies the items to the site (internal; the callers checked the right, the step-up and the values). p_items: [{item, text}]. Returns {before, after, columns_before,
-- columns_after, moved_from}: the text of each field before and after (as Change Control reads it). Scope or scenario items run the applicability and the conflict rule.
CREATE OR REPLACE FUNCTION ao_site_apply(p_site uuid, p_items jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  c jsonb; item text; v jsonb; s public.sites%ROWTYPE; col text; before_ jsonb := '{}'::jsonb; after_ jsonb := '{}'::jsonb; cb jsonb := '{}'::jsonb; ca jsonb := '{}'::jsonb;
  moved_from int; scope_touch boolean := false; conflicts jsonb; cf jsonb; real_conflicts jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO s FROM public.sites WHERE id = p_site FOR UPDATE;
  FOR c IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    item := c ->> 'item';
    before_ := before_ || jsonb_build_object(item, public.p4a_site_current(p_site, item));
    IF item = ANY (public.si_identity_items()) THEN cb := cb || public.si_site_cols(p_site, item); END IF;
    v := public.ao_parse(p_site, item, c ->> 'text');
    IF item = 'site.name' THEN
      UPDATE public.sites SET name = v #>> '{}', updated_at = clock_timestamp() WHERE id = p_site;
    ELSIF item = 'site.name_ar' THEN
      UPDATE public.sites SET name_ar = CASE WHEN v = 'null'::jsonb THEN NULL ELSE v #>> '{}' END, updated_at = clock_timestamp() WHERE id = p_site;
    ELSIF item = 'site.coordinates' THEN
      UPDATE public.sites SET latitude = (v ->> 'latitude')::numeric, longitude = (v ->> 'longitude')::numeric, updated_at = clock_timestamp() WHERE id = p_site;
    ELSIF item = 'site.region' THEN
      IF moved_from IS NULL THEN moved_from := (SELECT x.region_id FROM public.sites x WHERE x.id = p_site); END IF;
      UPDATE public.sites SET region_id = (v ->> 'region_id')::int, cluster_id = (v ->> 'cluster_id')::uuid, updated_at = clock_timestamp() WHERE id = p_site;
    ELSIF item = 'site.cluster' THEN
      UPDATE public.sites SET cluster_id = (v ->> 'cluster_id')::uuid, updated_at = clock_timestamp() WHERE id = p_site;
    ELSIF item LIKE 'site.custom.%' THEN
      UPDATE public.sites SET custom = CASE WHEN v = 'null'::jsonb THEN custom - substr(item, 13) ELSE custom || jsonb_build_object(substr(item, 13), v) END, updated_at = clock_timestamp()
      WHERE id = p_site;
    ELSIF item = 'site.site_scenario' THEN
      scope_touch := true;
      UPDATE public.sites SET site_scenario = v #>> '{}', delivery_scenario = replace(lower(v #>> '{}'), ' ', '_')::"DeliveryScenario", updated_at = clock_timestamp() WHERE id = p_site;
    ELSE
      scope_touch := true;
      col := substr(item, 6);
      EXECUTE format('UPDATE public.sites SET %I = $1::"ScopeFlag", updated_at = clock_timestamp() WHERE id = $2', col) USING v #>> '{}', p_site;
    END IF;
    after_ := after_ || jsonb_build_object(item, public.p4a_site_current(p_site, item));
    IF item = ANY (public.si_identity_items()) THEN ca := ca || public.si_site_cols(p_site, item); END IF;
  END LOOP;
  IF scope_touch THEN
    PERFORM public.p4a_hook('wf_apply_applicability', p_site);
    conflicts := public.p4a_hook('scope_scenario_conflicts', p_site);
    IF conflicts IS NOT NULL THEN
      FOR cf IN SELECT * FROM jsonb_array_elements(conflicts) LOOP
        IF cf IS NOT NULL AND cf NOT IN ('null'::jsonb, '[]'::jsonb, '{}'::jsonb, 'false'::jsonb, '""'::jsonb) THEN real_conflicts := real_conflicts || jsonb_build_array(cf); END IF;
      END LOOP;
      IF jsonb_array_length(real_conflicts) > 0 THEN
        PERFORM public.wf_err('validation_failed', jsonb_build_object('conflicts', real_conflicts,
          'errors', jsonb_build_array(jsonb_build_object('path', '/scenario', 'code', 'scope_scenario_conflict',
            'message', 'The scope and the scenario of the site conflict after this change (Q3): change both together.'))));
      END IF;
    END IF;
  END IF;
  PERFORM public.calc_refresh_site(p_site);
  RETURN jsonb_build_object('before', before_, 'after', after_, 'columns_before', cb, 'columns_after', ca, 'moved_from', moved_from);
END $$;

-- The edit (API door). p_patch: {identity: {name, name_ar, latitude, longitude, region_id, cluster_code, site_code}, scenario, scope: {<flag>: yes|na}, custom: {<code>: value}}.
CREATE OR REPLACE FUNCTION site_admin_edit(p_site uuid, p_seen timestamptz, p_patch jsonb, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid; s public.sites%ROWTYPE; rs text; k text; cand jsonb := '[]'::jsonb; items jsonb := '[]'::jsonb; errs jsonb := '[]'::jsonb; c jsonb; chk jsonb; ident jsonb;
  has_lat boolean; has_lon boolean; has_reg boolean; has_cl boolean; rnum int; rname text; ctxt text; fl text; applied jsonb; oid uuid; why text;
  flags text[] := ARRAY['tower_erection', 'site_adaption', 'gecol_power', 'hlc_fiber', 'te_full', 'te_ip_router_only'];
  ikeys text[] := ARRAY['name', 'name_ar', 'latitude', 'longitude', 'region_id', 'cluster_code', 'site_code'];
BEGIN
  actor := public.ao_require_admin();
  SELECT * INTO s FROM public.sites WHERE id = p_site FOR UPDATE;
  IF NOT FOUND OR NOT public.app_region_check(s.region_id) THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The site does not exist or is not visible to you.'));
  END IF;
  IF p_seen IS NOT NULL AND s.updated_at IS DISTINCT FROM p_seen THEN
    PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The site changed since you read it. Reload and try again.'));
  END IF;
  rs := public.ao_reason(p_reason);
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' OR p_patch = '{}'::jsonb THEN PERFORM public.ao_fail('/identity', 'required', 'Send at least one field.'); END IF;
  FOR k IN SELECT jsonb_object_keys(p_patch) LOOP
    IF k NOT IN ('identity', 'scenario', 'scope', 'custom') THEN errs := errs || public.reg_err_item('/' || left(k, 60), 'unknown_field', 'This part cannot be edited.'); END IF;
  END LOOP;

  -- identity
  ident := p_patch -> 'identity';
  IF ident IS NOT NULL THEN
    IF jsonb_typeof(ident) <> 'object' THEN errs := errs || public.reg_err_item('/identity', 'invalid', 'An object is expected.');
    ELSE
      FOR k IN SELECT jsonb_object_keys(ident) ORDER BY 1 LOOP
        IF NOT (k = ANY (ikeys)) THEN errs := errs || public.reg_err_item('/identity/' || left(k, 60), 'unknown_field', 'This field cannot be edited.');
        ELSIF jsonb_typeof(ident -> k) NOT IN ('string', 'number', 'null') THEN errs := errs || public.reg_err_item('/identity/' || k, 'invalid', 'A single value is expected.');
        END IF;
      END LOOP;
      IF ident ? 'site_code' THEN errs := errs || public.reg_err_item('/identity/site_code', 'immutable', 'The Site ID never changes.'); END IF;
      FOREACH k IN ARRAY ARRAY['name', 'name_ar'] LOOP
        IF ident ? k THEN
          cand := cand || jsonb_build_array(jsonb_build_object('item', 'site.' || k, 'base', '/identity', 'key', k,
            'text', CASE WHEN jsonb_typeof(ident -> k) = 'null' THEN '' ELSE ident ->> k END));
        END IF;
      END LOOP;
      has_lat := ident ? 'latitude'; has_lon := ident ? 'longitude'; has_reg := ident ? 'region_id'; has_cl := ident ? 'cluster_code';
      IF has_lat OR has_lon THEN
        IF has_lat <> has_lon THEN
          errs := errs || public.reg_err_item('/identity/' || CASE WHEN has_lat THEN 'longitude' ELSE 'latitude' END, 'pair_required', 'Latitude and longitude go together.');
        ELSIF jsonb_typeof(ident -> 'latitude') = 'null' AND jsonb_typeof(ident -> 'longitude') = 'null' THEN
          cand := cand || jsonb_build_array(jsonb_build_object('item', 'site.coordinates', 'base', '/identity', 'key', 'latitude', 'text', '(none)'));
        ELSE
          cand := cand || jsonb_build_array(jsonb_build_object('item', 'site.coordinates', 'base', '/identity', 'key', 'latitude',
            'text', coalesce(ident ->> 'latitude', '') || ', ' || coalesce(ident ->> 'longitude', '')));
        END IF;
      END IF;
      IF has_cl THEN ctxt := coalesce(nullif(btrim(ident ->> 'cluster_code'), ''), '(none)'); END IF;
      IF has_reg THEN
        IF jsonb_typeof(ident -> 'region_id') = 'number' AND (ident ->> 'region_id') ~ '^[0-9]{1,3}$' THEN rnum := (ident ->> 'region_id')::int;
        ELSE errs := errs || public.reg_err_item('/identity/region_id', 'invalid', 'A region id.'); END IF;
        IF rnum IS NOT NULL THEN
          SELECT r.name_en INTO rname FROM public.regions r WHERE r.id = rnum;
          IF rname IS NULL THEN errs := errs || public.reg_err_item('/identity/region_id', 'unknown_region', 'Unknown region.');
          ELSIF rnum = s.region_id THEN
            IF has_cl THEN cand := cand || jsonb_build_array(jsonb_build_object('item', 'site.cluster', 'base', '/identity', 'key', 'cluster_code', 'text', ctxt)); END IF;
          ELSE
            cand := cand || jsonb_build_array(jsonb_build_object('item', 'site.region', 'base', '/identity', 'key', 'region_id', 'text', rname || CASE WHEN has_cl THEN ' / ' || ctxt ELSE '' END));
          END IF;
        END IF;
      ELSIF has_cl THEN
        cand := cand || jsonb_build_array(jsonb_build_object('item', 'site.cluster', 'base', '/identity', 'key', 'cluster_code', 'text', ctxt));
      END IF;
    END IF;
  END IF;

  -- scenario
  IF p_patch ? 'scenario' THEN
    IF jsonb_typeof(p_patch -> 'scenario') <> 'string' THEN errs := errs || public.reg_err_item('/scenario', 'invalid', 'New Build, Expansion, Hot Swap, Cold Swap or Relocation.');
    ELSE cand := cand || jsonb_build_array(jsonb_build_object('item', 'site.site_scenario', 'base', '', 'key', 'scenario', 'text', p_patch ->> 'scenario')); END IF;
  END IF;

  -- scope flags
  IF p_patch ? 'scope' THEN
    IF jsonb_typeof(p_patch -> 'scope') <> 'object' THEN errs := errs || public.reg_err_item('/scope', 'invalid', 'An object is expected.');
    ELSE
      FOR k IN SELECT jsonb_object_keys(p_patch -> 'scope') ORDER BY 1 LOOP
        IF NOT (k = ANY (flags)) THEN errs := errs || public.reg_err_item('/scope/' || left(k, 60), 'unknown_field', 'Not a scope flag.');
        ELSIF jsonb_typeof(p_patch -> 'scope' -> k) <> 'string' THEN errs := errs || public.reg_err_item('/scope/' || k, 'invalid', 'A scope flag is Yes or N/A.');
        ELSE
          fl := lower(p_patch -> 'scope' ->> k);
          cand := cand || jsonb_build_array(jsonb_build_object('item', 'site.scope_' || k, 'base', '/scope', 'key', k, 'text', CASE fl WHEN 'yes' THEN 'Yes' WHEN 'na' THEN 'N/A' ELSE fl END));
        END IF;
      END LOOP;
    END IF;
  END IF;

  -- custom fields (any active site field; the field access rules do not bind a System Admin)
  IF p_patch ? 'custom' THEN
    IF jsonb_typeof(p_patch -> 'custom') <> 'object' THEN errs := errs || public.reg_err_item('/custom', 'invalid', 'An object is expected.');
    ELSE
      FOR k IN SELECT jsonb_object_keys(p_patch -> 'custom') ORDER BY 1 LOOP
        IF jsonb_typeof(p_patch -> 'custom' -> k) IN ('object', 'array') THEN errs := errs || public.reg_err_item('/custom/' || left(k, 60), 'invalid', 'A single value is expected.');
        ELSIF NOT EXISTS (SELECT 1 FROM public.field_definitions d WHERE d.entity_type = 'site' AND d.task_code IS NULL AND d.is_active AND d.code = k) THEN
          errs := errs || public.reg_err_item('/custom/' || left(k, 60), 'unknown_field', 'No active site field has this code.');
        ELSE cand := cand || jsonb_build_array(jsonb_build_object('item', 'site.custom.' || k, 'base', '/custom', 'key', k, 'text', public.p4a_site_value_text(p_patch -> 'custom' -> k)));
        END IF;
      END LOOP;
    END IF;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  FOR c IN SELECT * FROM jsonb_array_elements(cand) LOOP
    chk := public.ao_check_item(p_site, c ->> 'item', c ->> 'text', c ->> 'base', c ->> 'key');
    IF jsonb_array_length(chk -> 'errors') > 0 THEN errs := errs || (chk -> 'errors');
    ELSIF chk ->> 'norm' IS DISTINCT FROM chk ->> 'cur' THEN items := items || jsonb_build_array(jsonb_build_object('item', c ->> 'item', 'text', chk ->> 'norm'));
    END IF;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  IF jsonb_array_length(items) = 0 THEN
    RETURN jsonb_build_object('changed', false, 'override_id', NULL, 'updated_at', s.updated_at);
  END IF;
  PERFORM public.ao_require_stepup();

  applied := public.ao_site_apply(p_site, items);
  INSERT INTO public.admin_overrides (entity, site_id, kind, reason, before, after, acted_by)
  VALUES ('site', p_site, 'site_edit', rs, applied -> 'before', applied -> 'after', actor) RETURNING id INTO oid;
  why := rs;
  PERFORM public.log_audit_write('site_admin_edit', 'site', p_site::text,
    jsonb_build_object('fields', applied -> 'before', 'columns', applied -> 'columns_before'),
    jsonb_build_object('fields', applied -> 'after', 'columns', applied -> 'columns_after', 'override_id', oid, 'admin_override', true), why, p_site,
    (SELECT x.region_id FROM public.sites x WHERE x.id = p_site), NULL, true);
  IF applied ->> 'moved_from' IS NOT NULL THEN
    PERFORM public.log_audit_write('site_region_moved_out', 'site', p_site::text, jsonb_build_object('fields', applied -> 'before', 'columns', applied -> 'columns_before'),
      jsonb_build_object('fields', applied -> 'after', 'columns', applied -> 'columns_after', 'override_id', oid), why, p_site, (applied ->> 'moved_from')::int, NULL, true);
  END IF;
  RETURN jsonb_build_object('changed', true, 'override_id', oid, 'updated_at', (SELECT x.updated_at FROM public.sites x WHERE x.id = p_site), 'fields', ao_keys(applied -> 'after'));
END $$;

-- The keys of a JSON object as a JSON array (the names of the fields an edit touched).
CREATE OR REPLACE FUNCTION ao_keys(p jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(k ORDER BY k), '[]'::jsonb) FROM jsonb_object_keys(p) k
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Revert (a task date or a site edit)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION admin_override_revert(p_override uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid; o public.admin_overrides%ROWTYPE; rs text; t public.task_instances%ROWTYPE; s public.sites%ROWTYPE; fld text; k text; items jsonb := '[]'::jsonb; applied jsonb;
  before_snap jsonb; moved_region int;
BEGIN
  actor := public.ao_require_admin();
  SELECT * INTO o FROM public.admin_overrides WHERE id = p_override FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.sites x WHERE x.id = o.site_id AND public.app_region_check(x.region_id)) THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The override does not exist or is not visible to you.'));
  END IF;
  rs := public.ao_reason(p_reason);
  IF o.reverted_at IS NOT NULL THEN
    PERFORM public.wf_err('override_not_revertible', jsonb_build_object('detail', 'This override was reverted already.'));
  END IF;
  IF NOT public.ao_current_matches(o.id) THEN
    PERFORM public.wf_err('override_not_revertible', jsonb_build_object('detail', CASE o.entity WHEN 'task' THEN 'The task date changed since this override.' ELSE 'The site changed since this edit.' END));
  END IF;
  PERFORM public.ao_require_stepup();
  IF o.entity = 'task' THEN
    t := public.wf_lock_task(o.task_id, NULL);
    SELECT k INTO fld FROM jsonb_object_keys(o.before) k LIMIT 1;
    before_snap := public.wf_snap(o.task_id);
    UPDATE public.admin_overrides SET reverted_at = clock_timestamp(), reverted_by = actor, revert_reason = rs WHERE id = o.id;
    PERFORM public.ao_task_write(o.task_id, fld, nullif(o.before ->> fld, '')::date,
      EXISTS (SELECT 1 FROM public.admin_overrides x WHERE x.task_id = o.task_id AND x.reverted_at IS NULL));
    PERFORM public.ao_task_step(o.task_id, 'override_revert', rs);
    PERFORM public.log_audit_write('task_override_reverted', 'task', o.task_id::text, before_snap,
      public.wf_snap(o.task_id) || jsonb_build_object('override_id', o.id, 'date_field', fld), rs, t.site_id, t.region_id, NULL, true);
    PERFORM public.ao_task_recalc(o.task_id, fld);
  ELSE
    FOR k IN SELECT jsonb_object_keys(o.before) LOOP
      items := items || jsonb_build_array(jsonb_build_object('item', k, 'text', coalesce(o.before ->> k, '(none)')));
    END LOOP;
    SELECT * INTO s FROM public.sites WHERE id = o.site_id FOR UPDATE;
    applied := public.ao_site_apply(o.site_id, items);
    UPDATE public.admin_overrides SET reverted_at = clock_timestamp(), reverted_by = actor, revert_reason = rs WHERE id = o.id;
    PERFORM public.log_audit_write('site_admin_edit_reverted', 'site', o.site_id::text,
      jsonb_build_object('fields', applied -> 'before', 'columns', applied -> 'columns_before'),
      jsonb_build_object('fields', applied -> 'after', 'columns', applied -> 'columns_after', 'override_id', o.id), rs, o.site_id,
      (SELECT x.region_id FROM public.sites x WHERE x.id = o.site_id), NULL, true);
    moved_region := nullif(applied ->> 'moved_from', '')::int;
    IF moved_region IS NOT NULL THEN
      PERFORM public.log_audit_write('site_region_moved_out', 'site', o.site_id::text, jsonb_build_object('fields', applied -> 'before'),
        jsonb_build_object('fields', applied -> 'after', 'override_id', o.id), rs, o.site_id, moved_region, NULL, true);
    END IF;
  END IF;
  RETURN public.ao_override_json(o.id);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Ownership and execute rights
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'ao_require_admin()', 'ao_require_stepup()', 'ao_fail(text,text,text)', 'ao_reason(text)', 'ao_task_date(uuid,text)', 'ao_current_matches(uuid)', 'ao_override_json(uuid)',
    'task_overrides_json(uuid)', 'site_admin_edits_json(uuid)', 'ao_task_recalc(uuid,text)', 'ao_task_write(uuid,text,date,boolean)', 'ao_task_step(uuid,text,text)',
    'task_override_create(uuid,integer,text,text,text,date,boolean)', 'ao_norm(text,jsonb)', 'ao_parse(uuid,text,text)', 'ao_check_item(uuid,text,text,text,text)',
    'ao_site_apply(uuid,jsonb)', 'site_admin_edit(uuid,timestamptz,jsonb,text)', 'ao_keys(jsonb)', 'admin_override_revert(uuid,text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY['site_admin_edit(uuid,timestamptz,jsonb,text)', 'task_override_create(uuid,integer,text,text,text,date,boolean)', 'admin_override_revert(uuid,text)',
                             'task_overrides_json(uuid)', 'site_admin_edits_json(uuid)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
