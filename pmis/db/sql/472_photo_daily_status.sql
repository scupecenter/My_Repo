-- 0473_photo_daily_status: decision 32, a photo field in the Daily Plan (per site and day) and in Status Updates (per update). Photos are document slots of a third and
-- fourth owner kind, so they follow the same upload, version, withdraw, audit and Gallery rules as every other document (kind photo appears in the Gallery on its own).
--   * document_slots gets daily_plan_row_id and status_update_id (additive, nullable); the owner check allows at most one owner. A slot keeps its site and region
--     (a status update is per region or team, so its photo is attached with a site picked from the region).
--   * Two document types, PHOTO_DAILY_PLAN and PHOTO_STATUS_UPDATE (kind photo, no placement): Settings > Documents > Document types edits mandatory, minimum and
--     maximum number of photos, formats and size; switching the type off hides the field. Nothing blocks a plan or an update: a missing photo only informs.
--   * Writes: doc_slot_owner_for_write learns the two owners. Daily plan: the view right of the region, an unlocked day and the L1 holders (dp_for_change and
--     dp_require_entry, the same as editing a row). Status update: its author, inside its week (the same rule as editing it). doc_slot_audit writes the audit row.
--   * Doors: doc_dp_photo_slot(region, date, site) and doc_su_photo_slot(update, site) make the stored row and the slot on first use and return the slot.
-- Data reset: no new table. The two columns are SET NULL on delete of the owner row; slots of project data are removed by the existing document_slots step.
-- Additive and safe to repeat. Mirror: db/sql/472_photo_daily_status.sql (kept identical to prisma/migrations/0473_photo_daily_status/migration.sql).

ALTER TABLE document_slots ADD COLUMN IF NOT EXISTS daily_plan_row_id uuid REFERENCES daily_plan_rows (id) ON DELETE SET NULL;
ALTER TABLE document_slots ADD COLUMN IF NOT EXISTS status_update_id uuid REFERENCES status_updates (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS document_slots_dp_row_idx ON document_slots (daily_plan_row_id) WHERE daily_plan_row_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS document_slots_su_idx ON document_slots (status_update_id) WHERE status_update_id IS NOT NULL;
ALTER TABLE document_slots DROP CONSTRAINT IF EXISTS document_slots_one_owner;
ALTER TABLE document_slots ADD CONSTRAINT document_slots_one_owner CHECK (num_nonnulls(task_id, register_entity_id, daily_plan_row_id, status_update_id) <= 1);

CREATE OR REPLACE FUNCTION doc_slot_owner_for_write(p_slot public.document_slots, p_actor uuid, p_verb text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE t public.task_instances%ROWTYPE; r public.register_records%ROWTYPE; d public.daily_plan_rows%ROWTYPE; dpl public.daily_plans%ROWTYPE; su public.status_updates%ROWTYPE;
BEGIN
  IF p_slot.task_id IS NOT NULL THEN
    t := public.wf_lock_task(p_slot.task_id, NULL);
    IF t.state NOT IN ('open', 'entry') THEN
      PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Documents can be ' || p_verb || ' only while the task is pending or ongoing (it is ' || t.state::text || ').'));
    END IF;
    PERFORM public.wf_require_grant(t.region_id, 'edit');
    PERFORM public.wf_require_actor(t.id, 'entry', p_actor);
    RETURN jsonb_build_object('kind', 'task', 'id', t.id);
  END IF;
  IF p_slot.daily_plan_row_id IS NOT NULL THEN
    SELECT * INTO d FROM public.daily_plan_rows WHERE id = p_slot.daily_plan_row_id;
    IF NOT FOUND THEN PERFORM public.wf_err('not_found'); END IF;
    SELECT * INTO dpl FROM public.daily_plans WHERE id = d.plan_id;
    PERFORM public.dp_for_change(dpl.region_id, dpl.plan_date, NULL);   -- the view right of the region and an unlocked day
    PERFORM public.dp_require_entry(dpl.region_id);                    -- the L1 holders of the region, or a System Admin
    RETURN jsonb_build_object('kind', 'daily_plan_row', 'id', d.id, 'plan_id', dpl.id, 'plan_date', dpl.plan_date, 'site_id', d.site_id, 'region_id', dpl.region_id);
  END IF;
  IF p_slot.status_update_id IS NOT NULL THEN
    SELECT * INTO su FROM public.status_updates WHERE id = p_slot.status_update_id;
    IF NOT FOUND THEN PERFORM public.wf_err('not_found'); END IF;
    IF su.author_id <> p_actor THEN PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only the author of a status update changes its photos.')); END IF;
    IF public.cal_today() > su.week_start + 6 THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The week of this update has ended; its photos can no longer be changed.')); END IF;
    RETURN jsonb_build_object('kind', 'status_update', 'id', su.id, 'site_id', p_slot.site_id, 'region_id', p_slot.region_id);
  END IF;
  IF p_slot.register_entity_id IS NULL THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This slot belongs to no task and no register record.'));
  END IF;
  SELECT * INTO r FROM public.register_records WHERE entity_id = p_slot.register_entity_id AND state IN ('entry', 'in_review', 'in_approval') ORDER BY version_no DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND OR r.state <> 'entry' THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Documents can be ' || p_verb || ' only while a version of the record is in Data Entry (start a new version of an approved record).'));
  END IF;
  r := public.reg_lock(r.id, NULL);
  PERFORM public.reg_require_grant(r.register_key, r.region_id, 'edit');
  PERFORM public.reg_require_actor(r.id, 'entry', p_actor);
  RETURN jsonb_build_object('kind', 'register_record', 'id', r.id);
END $$;

CREATE OR REPLACE FUNCTION doc_slot_audit(p_owner jsonb, p_action text, p_before jsonb, p_after jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_owner ->> 'kind' = 'task' THEN
    PERFORM public.wf_audit(p_action, (p_owner ->> 'id')::uuid, p_before, p_after, NULL);
  ELSIF p_owner ->> 'kind' = 'daily_plan_row' THEN
    PERFORM public.log_audit_write('daily_plan.' || p_action, 'daily_plan', p_owner ->> 'plan_id', p_before,
      coalesce(p_after, '{}'::jsonb) || jsonb_build_object('plan_date', p_owner ->> 'plan_date'), NULL, (p_owner ->> 'site_id')::uuid, (p_owner ->> 'region_id')::int);
  ELSIF p_owner ->> 'kind' = 'status_update' THEN
    PERFORM public.log_audit_write('status_update.' || p_action, 'status_update', p_owner ->> 'id', p_before, p_after, NULL, (p_owner ->> 'site_id')::uuid, (p_owner ->> 'region_id')::int);
  ELSE
    PERFORM public.reg_audit(p_action, (p_owner ->> 'id')::uuid, p_before, p_after, NULL);
  END IF;
END $$;

-- A slot of any owner can be withdrawn from.
DO $$
DECLARE def text; old text := '(s.task_id IS NULL AND s.register_entity_id IS NULL)'; nw text := '(s.task_id IS NULL AND s.register_entity_id IS NULL AND s.daily_plan_row_id IS NULL AND s.status_update_id IS NULL)';
BEGIN
  def := pg_get_functiondef('public.doc_withdraw_file(uuid,uuid)'::regprocedure);
  IF position(old IN def) > 0 THEN EXECUTE replace(def, old, nw);
  ELSIF position(nw IN def) = 0 THEN RAISE EXCEPTION 'doc_withdraw_file: the owner guard anchor was not found'; END IF;
END $$;

-- The slot of a daily plan row (made on first use). p_code is the document type code; the type must be active and published.
CREATE OR REPLACE FUNCTION doc_dp_photo_slot(p_region integer, p_date date, p_site uuid, p_code text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE p public.daily_plans%ROWTYPE; old public.daily_plan_rows%ROWTYPE; s public.sites%ROWTYPE; dt record; rid uuid; sid uuid; ok boolean;
BEGIN
  p := public.dp_for_change(p_region, p_date, NULL);
  PERFORM public.dp_require_entry(p_region);
  SELECT * INTO s FROM public.sites WHERE id = p_site;
  old := public.dp_stored(p.id, p_site);
  ok := s.id IS NOT NULL AND s.region_id = p_region
        AND ((old.id IS NOT NULL AND NOT old.removed AND (old.origin = 'added' OR EXISTS (SELECT 1 FROM public.dp_auto_sites(p_region, p_date) a WHERE a.site_id = p_site)))
             OR (old.id IS NULL AND EXISTS (SELECT 1 FROM public.dp_auto_sites(p_region, p_date) a WHERE a.site_id = p_site)));
  IF NOT ok THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The site is not in this plan.')); END IF;
  SELECT dt2.id, v.id AS vid INTO dt FROM public.document_types dt2 JOIN public.document_type_versions v ON v.doc_type_id = dt2.id AND v.version_no = dt2.published_version
   WHERE dt2.code = p_code AND dt2.code = 'PHOTO_DAILY_PLAN' AND dt2.is_active AND dt2.published_version > 0;
  IF NOT FOUND THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/doc_code', 'code', 'unknown_document', 'message', 'The photo field of the Daily Plan is switched off in Settings > Documents.')))); END IF;
  IF old.id IS NULL THEN
    INSERT INTO public.daily_plan_rows (plan_id, region_id, site_id, origin, updated_by, updated_at) VALUES (p.id, p_region, p_site, 'auto', public.app_actor(), clock_timestamp())
    ON CONFLICT (plan_id, site_id) DO NOTHING;
    old := public.dp_stored(p.id, p_site);
  END IF;
  rid := old.id;
  SELECT id INTO sid FROM public.document_slots WHERE daily_plan_row_id = rid AND doc_type_id = dt.id;
  IF sid IS NULL THEN
    INSERT INTO public.document_slots (daily_plan_row_id, site_id, region_id, is_global, doc_type_id, status, doc_type_version_id)
    VALUES (rid, p_site, p_region, false, dt.id, 'missing', dt.vid) RETURNING id INTO sid;
  END IF;
  RETURN sid;
END $$;

-- The slot of a status update for one site of its region (made on first use).
CREATE OR REPLACE FUNCTION doc_su_photo_slot(p_update uuid, p_site uuid, p_code text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE su public.status_updates%ROWTYPE; s public.sites%ROWTYPE; dt record; sid uuid; seen int[];
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO su FROM public.status_updates WHERE id = p_update FOR UPDATE;
  seen := public.wf_actor_regions('sites', 'view');
  IF NOT FOUND OR (seen IS NOT NULL AND (cardinality(seen) = 0 OR (su.region_id IS NOT NULL AND NOT (su.region_id = ANY (seen))))) THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The status update does not exist or is not visible to you.'));
  END IF;
  IF su.author_id <> public.app_actor() THEN PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only the author of a status update changes its photos.')); END IF;
  IF public.cal_today() > su.week_start + 6 THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The week of this update has ended; its photos can no longer be changed.')); END IF;
  SELECT * INTO s FROM public.sites WHERE id = p_site;
  IF s.id IS NULL OR NOT public.app_region_check(s.region_id) OR (su.region_id IS NOT NULL AND s.region_id <> su.region_id) THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The site is not in the region of this update.'));
  END IF;
  SELECT dt2.id, v.id AS vid INTO dt FROM public.document_types dt2 JOIN public.document_type_versions v ON v.doc_type_id = dt2.id AND v.version_no = dt2.published_version
   WHERE dt2.code = p_code AND dt2.code = 'PHOTO_STATUS_UPDATE' AND dt2.is_active AND dt2.published_version > 0;
  IF NOT FOUND THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/doc_code', 'code', 'unknown_document', 'message', 'The photo field of Status Updates is switched off in Settings > Documents.')))); END IF;
  SELECT id INTO sid FROM public.document_slots WHERE status_update_id = su.id AND doc_type_id = dt.id AND site_id = s.id;
  IF sid IS NULL THEN
    INSERT INTO public.document_slots (status_update_id, site_id, region_id, is_global, doc_type_id, status, doc_type_version_id)
    VALUES (su.id, s.id, s.region_id, false, dt.id, 'missing', dt.vid) RETURNING id INTO sid;
  END IF;
  RETURN sid;
END $$;

-- Whether the signed-in user may change the photos now (the screens show or hide the upload; the write rules above are the gate).
CREATE OR REPLACE FUNCTION doc_dp_photo_can(p_region integer, p_date date) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.app_actor() IS NULL OR p_region IS NULL OR NOT public.app_region_check(p_region) THEN RETURN false; END IF;
  IF NOT public.dp_right(public.app_actor(), p_region, 'view') THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.daily_plans WHERE region_id = p_region AND plan_date = p_date AND locked_at IS NOT NULL) THEN RETURN false; END IF;
  RETURN public.app_user_is_system_admin(public.app_actor()) OR public.dp_holds(public.app_actor(), p_region, 'entry');
END $$;

CREATE OR REPLACE FUNCTION doc_su_photo_can(p_update uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.status_updates u WHERE u.id = p_update AND u.author_id = public.app_actor() AND public.cal_today() <= u.week_start + 6)
$$;

-- The two photo field types: kind photo, no placement (the field sits on the screen, not on a record), optional, at least one photo, images only.
DO $$
DECLARE r record; did uuid; spec jsonb;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('PHOTO_DAILY_PLAN',    'Daily Plan: site photos of the day', 'الخطة اليومية: صور الموقع لليوم'),
    ('PHOTO_STATUS_UPDATE', 'Status Update: photos',              'تحديث الحالة: الصور')
  ) AS v(code, name_en, name_ar) LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM document_types WHERE code = r.code);
    spec := jsonb_build_object('kind', 'photo', 'form_kind', NULL, 'name_en', r.name_en, 'name_ar', r.name_ar,
      'placements', '[]'::jsonb, 'mandatory', false, 'condition_rule', NULL,
      'formats', jsonb_build_array('jpg', 'jpeg', 'png', 'webp', 'heic'), 'max_size_mb', 20, 'min_files', 1, 'max_files', NULL, 'photo_rules', NULL,
      'expiry_tracked', false, 'blank_form_file_id', NULL, 'is_active', true);
    INSERT INTO document_types (code, name_en, kind, is_active, lib_managed, published_version, needs_review, updated_at)
    VALUES (r.code, r.name_en, 'photo', false, true, 0, false, now()) RETURNING id INTO did;
    PERFORM doc_apply_spec(did, spec);
    UPDATE document_types SET is_active = true WHERE id = did;
    PERFORM doc_snapshot_version(did, 'new_only', DATE '2024-01-01', 'seed: migration 0473 (decision 32 photo fields)', 0);
  END LOOP;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION doc_dp_photo_slot(integer, date, uuid, text), doc_su_photo_slot(uuid, uuid, text), doc_dp_photo_can(integer, date), doc_su_photo_can(uuid) TO pmis_app;
  END IF;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['doc_dp_photo_slot(integer,date,uuid,text)', 'doc_su_photo_slot(uuid,uuid,text)', 'doc_dp_photo_can(integer,date)', 'doc_su_photo_can(uuid)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
END $$;
