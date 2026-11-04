-- 0068_followup_qc_registers: follow-up group C of the technical decisions of 2026-11-04 (docs/spec/technical-decisions-2026-11-04.md; contract 0.13.2;
-- CHANGELOG 96). Mirrored byte-identically as db/sql/067_followup_qc_registers.sql.
--
--   1. Q260  The Quality register's Severity field reads the snag severity codes CRITICAL, MAJOR and MINOR. The catalogue `Severity` (0057) now mirrors
--            snag_severities (0056): its values are those codes (EN and AR names, order and active flag from the snag list), written only by the mirror
--            (sync_severity_catalogue, run by a trigger on snag_severities); a direct write to a Severity value is refused. The old values Critical,
--            Major and Minor become the codes in place (same value id) and the saved records are rewritten to the code where the old text matches a
--            code or an English name without doubt; any other old value stays as an inactive value (readable) and is listed in the audit row.
--   2. Q265  Accepting pending evidence needs step-up, like the closure of a snag: qc_decide_evidence takes the step-up flag (the old four-argument
--            function is dropped). Rejecting evidence does not need it.
--   3. Q267  qc_cancel_snag_record: a System Admin cancels an approved Quality record of type snag that was entered by mistake. A reason and step-up
--            are required; the record becomes voided, its QC snag is cancelled with it (trigger z_qc_record_moved of 0056, reason kept), and the act is
--            audited with before and after through log_audit_write. A record whose QC snag is closed, or that has an open newer version, is refused.
--   4. Q291  Meetings: the optional text field external_attendees (vendors, GECOL, HLC, landlords) beside attendee_users.
--   5. Q296  template_task_fields.list_catalogue: the task fields of the stream templates that held the options Done / Pending / N/A read the
--            catalogue CompletionStatus; their options are the active codes of the catalogue and follow it.
--   6. Q349  No schema change (the site page reads the setting dashboard.pipeline_variant through dash_pipeline_variant(), 0059).
--   7. Q393  dash_sec_delay: a late task whose SLA rule is marked pending_confirmation (0052) is left out of the delay scorecard (its days stay in the total
--            delay and in the items); delay.scorecard_excluded_working_days and scorecard_excluded_tasks tell how much was left out. The task colour is unchanged.
--   8. Q330  contractors_daily_alerts: a certificate alert (due, expired) repeats every 7 days until the expiry date is renewed
--            (contractor_alerts_sent.last_sent_on and times); a renewed date starts again as a new alert.
--
-- Every function is SECURITY DEFINER with a fixed search_path, owned by pmis_definer, PUBLIC revoked; pmis_app stays read-only on tables and the audit
-- rows go through log_audit_write.

SELECT set_config('app.region_ids', '*', true);

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Q260: the Severity list mirrors the snag severities
-- ---------------------------------------------------------------------------------------------------------------------
-- A write to a value of the list through the application (the admin functions of the list catalogue) is refused: the list follows snag_severities
-- (Settings, QC snags). The migration role and the superuser (app_is_seeding) are not the application and keep their rights; the check needs the user who
-- runs the statement, so this one trigger function is not SECURITY DEFINER (current_user inside a definer function would be its owner, pmis_definer).
CREATE OR REPLACE FUNCTION severity_catalogue_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF coalesce(current_setting('app.severity_sync', true), '') <> 'on' AND NOT public.app_is_seeding() THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'mirrored_list',
      'The list Severity follows the snag severities (Settings, QC snag severities): change them there (Q260).')));
  END IF;
  RETURN NEW;
END $$;

-- The values of the list = the snag severities: code, EN / AR name, order and active flag. Another old value is deactivated, never removed.
-- Does nothing when the list already agrees (a statement trigger of list_values re-issues the templates on every statement).
CREATE OR REPLACE FUNCTION sync_severity_catalogue() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.snag_severities s LEFT JOIN public.list_values v ON v.catalogue_code = 'Severity' AND v.code = s.code
                 WHERE v.id IS NULL OR (v.label_en, v.label_ar, v.sort_order, v.is_active) IS DISTINCT FROM (s.name_en, s.name_ar, s.sort_order, s.is_active))
     AND NOT EXISTS (SELECT 1 FROM public.list_values v WHERE v.catalogue_code = 'Severity' AND v.is_active
                     AND NOT EXISTS (SELECT 1 FROM public.snag_severities s WHERE s.code = v.code)) THEN
    RETURN;
  END IF;
  PERFORM set_config('app.severity_sync', 'on', true);
  INSERT INTO public.list_values (catalogue_code, code, label_en, label_ar, sort_order, is_active)
  SELECT 'Severity', s.code, s.name_en, s.name_ar, s.sort_order, s.is_active FROM public.snag_severities s
  ON CONFLICT (catalogue_code, code) DO UPDATE SET label_en = EXCLUDED.label_en, label_ar = EXCLUDED.label_ar, sort_order = EXCLUDED.sort_order,
    is_active = EXCLUDED.is_active, version = list_values.version + 1, updated_at = now()
  WHERE (list_values.label_en, list_values.label_ar, list_values.sort_order, list_values.is_active) IS DISTINCT FROM (EXCLUDED.label_en, EXCLUDED.label_ar, EXCLUDED.sort_order, EXCLUDED.is_active);
  UPDATE public.list_values v SET is_active = false, version = v.version + 1, updated_at = now()
  WHERE v.catalogue_code = 'Severity' AND v.is_active AND NOT EXISTS (SELECT 1 FROM public.snag_severities s WHERE s.code = v.code);
  PERFORM public.list_refresh_fields('Severity');
  PERFORM set_config('app.severity_sync', 'off', true);
END $$;

CREATE OR REPLACE FUNCTION snag_severities_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.sync_severity_catalogue();
  RETURN NULL;
END $$;

-- The old values become the codes (same value id, so nothing that points at the value breaks), the saved records follow, then the mirror runs.
DO $$
DECLARE v record; target text; renamed int := 0; remapped int := 0; kept jsonb;
BEGIN
  PERFORM set_config('app.severity_sync', 'on', true);
  ALTER TABLE list_values DISABLE TRIGGER list_values_guard;   -- the code of a value never changes; this one-time conversion is the only exception
  FOR v IN SELECT lv.id, lv.code FROM list_values lv WHERE lv.catalogue_code = 'Severity' ORDER BY lv.sort_order, lv.code COLLATE "C" LOOP
    SELECT s.code INTO target FROM snag_severities s
    WHERE s.code = upper(btrim(v.code)) OR lower(s.name_en) = lower(btrim(v.code))
    ORDER BY (s.code = upper(btrim(v.code))) DESC, s.code COLLATE "C" LIMIT 1;
    IF target IS NULL OR target = v.code THEN CONTINUE; END IF;
    IF NOT EXISTS (SELECT 1 FROM list_values x WHERE x.catalogue_code = 'Severity' AND x.code = target) THEN
      UPDATE list_values SET code = target, version = version + 1, updated_at = now() WHERE id = v.id;
      renamed := renamed + 1;
    END IF;
  END LOOP;
  ALTER TABLE list_values ENABLE TRIGGER list_values_guard;
  -- the saved records of the Quality register (every version): the text of the Severity field becomes the code when it names one code without doubt
  WITH m AS (
    SELECT x.id, (SELECT s.code FROM snag_severities s
                  WHERE s.code = upper(btrim(x.data ->> 'severity')) OR lower(s.name_en) = lower(btrim(x.data ->> 'severity'))
                  ORDER BY (s.code = upper(btrim(x.data ->> 'severity'))) DESC, s.code COLLATE "C" LIMIT 1) AS code
    FROM register_records x WHERE x.register_key = 'quality' AND jsonb_typeof(x.data -> 'severity') = 'string'
  )
  UPDATE register_records r SET data = jsonb_set(r.data, '{severity}', to_jsonb(m.code))
  FROM m WHERE m.id = r.id AND m.code IS NOT NULL AND r.data ->> 'severity' <> m.code;
  GET DIAGNOSTICS remapped = ROW_COUNT;
  SELECT coalesce(jsonb_agg(x.sv ORDER BY x.sv), '[]'::jsonb) INTO kept FROM (
    SELECT DISTINCT r.data ->> 'severity' AS sv FROM register_records r
    WHERE r.register_key = 'quality' AND jsonb_typeof(r.data -> 'severity') = 'string' AND btrim(r.data ->> 'severity') <> ''
      AND NOT EXISTS (SELECT 1 FROM snag_severities s WHERE s.code = r.data ->> 'severity')) x;
  PERFORM set_config('app.severity_sync', 'off', true);
  PERFORM public.p6_audit('severity_catalogue_mirror', 'list_catalogue', 'Severity', NULL,
    jsonb_build_object('values_renamed', renamed, 'records_rewritten', remapped, 'unmapped_values_kept', kept),
    'Owner decision Q260 (2026-11-04): the Quality register Severity field reads the snag severity codes CRITICAL, MAJOR and MINOR.', NULL, NULL);
END $$;

CREATE TRIGGER a_severity_guard BEFORE INSERT OR UPDATE ON list_values FOR EACH ROW WHEN (NEW.catalogue_code = 'Severity') EXECUTE FUNCTION severity_catalogue_guard();
CREATE TRIGGER z_sync_severity_catalogue AFTER INSERT OR UPDATE ON snag_severities FOR EACH STATEMENT EXECUTE FUNCTION snag_severities_changed();

UPDATE list_catalogues SET version = version + 1, updated_at = now(),
  description = 'The snag severities (CRITICAL and MAJOR block, MINOR does not): this list mirrors them and is changed in Settings, QC snag severities (Q260, migration 0068).'
WHERE code = 'Severity';
SELECT sync_severity_catalogue();

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Q265: accepting pending evidence needs step-up (rejecting does not)
-- ---------------------------------------------------------------------------------------------------------------------
-- The flag defaults to false: a call that still has the four old arguments is safe (accepting is then refused with step_up_required), and the old
-- four-argument function itself is dropped, so there is exactly one function.
DROP FUNCTION qc_decide_evidence(uuid, uuid, boolean, text);
CREATE OR REPLACE FUNCTION qc_decide_evidence(p_snag uuid, p_photo uuid, p_accept boolean, p_note text, p_stepup boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); s public.snags%ROWTYPE; p public.snag_photos%ROWTYPE; before_ jsonb;
BEGIN
  s := public.qc_lock_snag(p_snag, NULL);
  SELECT * INTO p FROM public.snag_photos WHERE id = p_photo AND snag_id = p_snag;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The photo is not on this snag.')); END IF;
  IF s.status NOT IN ('open', 'fix_uploaded', 'in_review') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The snag is ' || s.status::text || '.'));
  END IF;
  IF p.evidence_status <> 'pending_evidence' OR p.withdrawn_at IS NOT NULL OR p.rejected_at IS NOT NULL THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Only a photo kept as pending evidence is decided.'));
  END IF;
  IF char_length(btrim(coalesce(p_note, ''))) < 3 THEN PERFORM public.wf_err('note_required'); END IF;
  IF actor = ANY (public.qc_snag_excluded(p_snag)) THEN
    PERFORM public.wf_err('self_approval_forbidden', jsonb_build_object('detail', 'You raised, found or fixed this snag: somebody else decides its evidence (owner decision D230b).'));
  END IF;
  PERFORM public.reg_require_grant('quality', s.region_id, 'approve');
  IF NOT (public.qc_snag_is_eligible(p_snag, 'approve', actor) OR (public.app_user_is_system_admin(actor) AND NOT public.qc_snag_has_holder(p_snag, 'approve'))) THEN
    PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'Only L2 of the snag decides pending evidence.'));
  END IF;
  -- Q265: accepting the evidence lets the fix be submitted, like the closure, so it needs step-up; rejecting it only removes a photo
  IF p_accept AND NOT coalesce(p_stepup, false) THEN PERFORM public.wf_err('step_up_required'); END IF;
  before_ := public.qc_snag_snap(p_snag);
  IF p_accept THEN
    UPDATE public.snag_photos SET evidence_status = 'accepted', evidence_note = left(btrim(p_note), 500), evidence_decided_by = actor, evidence_decided_at = now() WHERE id = p_photo;
  ELSE
    UPDATE public.snag_photos SET rejected_at = now(), review_note = left(btrim(p_note), 500), evidence_note = left(btrim(p_note), 500), evidence_decided_by = actor, evidence_decided_at = now()
    WHERE id = p_photo;
  END IF;
  PERFORM public.qc_refresh_status(p_snag);
  UPDATE public.snags SET version = version + 1, updated_at = now() WHERE id = p_snag;
  PERFORM public.qc_audit(CASE WHEN p_accept THEN 'snag_evidence_accept' ELSE 'snag_evidence_reject' END, p_snag, before_,
    public.qc_snag_snap(p_snag) || jsonb_build_object('photo_id', p_photo) || CASE WHEN p_accept THEN jsonb_build_object('stepup_verified', true) ELSE '{}'::jsonb END, btrim(p_note));
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Q267: a System Admin cancels an approved Quality snag record entered by mistake
-- ---------------------------------------------------------------------------------------------------------------------
-- Only the approved version in force of a Quality record of type snag. The record is voided (never deleted); its QC snag, while not closed, is cancelled
-- by the trigger z_qc_record_moved with the reason of the cancellation. A closed QC snag is history and stays: the cancellation is refused.
CREATE OR REPLACE FUNCTION qc_cancel_snag_record(p_record uuid, p_version integer, p_reason text, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); r public.register_records%ROWTYPE; s public.snags%ROWTYPE; before_ jsonb; had_snag boolean;
BEGIN
  -- the caller first: only a System Admin (a delegate is not one) cancels, whatever the record is; then the record is read, which answers not_found for
  -- an admin outside the record's regions as for every register write
  IF NOT coalesce(public.app_user_is_system_admin(actor), false) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only a System Admin cancels an approved Quality snag record.'));
  END IF;
  r := public.reg_lock(p_record, p_version);
  IF char_length(btrim(coalesce(p_reason, ''))) < 3 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/reason', 'required', 'A reason of at least 3 characters is required.')));
  END IF;
  IF r.register_key <> 'quality' OR r.record_type IS DISTINCT FROM 'snag' THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Only a Quality record of type snag is cancelled this way.'));
  END IF;
  IF r.state <> 'approved' OR NOT r.is_current THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Only the approved version in force can be cancelled (this one is ' || r.state || ').'));
  END IF;
  IF EXISTS (SELECT 1 FROM public.register_records o WHERE o.entity_id = r.entity_id AND o.id <> r.id AND o.state IN ('entry', 'in_review', 'in_approval')) THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'A newer version of this record is open: void it first.'));
  END IF;
  SELECT * INTO s FROM public.snags WHERE register_entity_id = r.entity_id FOR UPDATE;
  had_snag := FOUND;
  IF had_snag AND s.status = 'closed' THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The QC snag of this record is closed already: its history stays and the record is not cancelled.'));
  END IF;
  IF NOT coalesce(p_stepup, false) THEN PERFORM public.wf_err('step_up_required'); END IF;
  before_ := public.reg_snap(p_record);
  UPDATE public.register_records SET state = 'voided', is_current = false, voided_at = now(), voided_by = actor, void_reason = btrim(p_reason),
    ball_in_court_user_id = NULL, level_opened_at = NULL, version = version + 1, updated_at = now() WHERE id = p_record;
  PERFORM public.reg_step(p_record, r.current_level, 'void', actor, btrim(p_reason), r.state, 'voided', true, false);
  PERFORM public.p6_audit('register_record_cancel_snag', 'register_record', p_record::text, before_,
    public.reg_snap(p_record) || jsonb_build_object('qc_snag_id', CASE WHEN had_snag THEN s.id END, 'qc_snag_status_before', CASE WHEN had_snag THEN s.status::text END,
                                                    'stepup_verified', true), btrim(p_reason), r.site_id, r.region_id);
  RETURN jsonb_build_object('id', p_record, 'qc_snag_id', CASE WHEN had_snag THEN s.id END,
    'qc_snag_cancelled', had_snag AND (SELECT x.status = 'cancelled' FROM public.snags x WHERE x.id = s.id));
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Q291: external attendees of a meeting (free text)
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO register_fields (register_key, code, label_en, label_ar, field_type, required, is_actual, derived, options, in_list, section, sort_order, list_catalogue) VALUES
  ('meetings', 'external_attendees', 'External attendees', 'الحضور من خارج النظام', 'text', false, false, false, NULL, false, 'Attendees and sites', 42, NULL)
ON CONFLICT (register_key, code) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Q296: the task fields of the stream templates read the CompletionStatus catalogue
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE template_task_fields ADD COLUMN list_catalogue TEXT REFERENCES list_catalogues (code) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE template_task_fields ADD CONSTRAINT template_task_fields_list_catalogue_type CHECK (list_catalogue IS NULL OR field_type = 'list');
COMMENT ON COLUMN template_task_fields.list_catalogue IS '0068 (Q296): the list catalogue a list field reads. Its options are then the active codes of the catalogue and follow it (CompletionStatus: Done, Pending, N/A).';

-- A linked field always carries the active codes of its catalogue; a field that is no longer a list leaves the catalogue.
CREATE OR REPLACE FUNCTION tpl_task_field_list() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.field_type <> 'list' THEN
    NEW.list_catalogue := NULL;
  ELSIF NEW.list_catalogue IS NOT NULL THEN
    NEW.options := public.list_active_codes(NEW.list_catalogue);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_tpl_task_field_list BEFORE INSERT OR UPDATE ON template_task_fields FOR EACH ROW EXECUTE FUNCTION tpl_task_field_list();

-- A change of the values of a list moves the options of the fields that read it (before tpl_list_values_changed re-issues the templates).
CREATE OR REPLACE FUNCTION tpl_task_fields_refresh() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.template_task_fields f WHERE f.list_catalogue IS NOT NULL AND f.options IS DISTINCT FROM public.list_active_codes(f.list_catalogue)) THEN
    UPDATE public.template_task_fields f SET options = public.list_active_codes(f.list_catalogue)
    WHERE f.list_catalogue IS NOT NULL AND f.options IS DISTINCT FROM public.list_active_codes(f.list_catalogue);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER list_values_task_fields AFTER INSERT OR UPDATE ON list_values FOR EACH STATEMENT EXECUTE FUNCTION tpl_task_fields_refresh();

UPDATE template_task_fields SET list_catalogue = 'CompletionStatus'
WHERE field_type = 'list' AND options = '["Done", "Pending", "N/A"]'::jsonb AND list_catalogue IS NULL;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Q393: SLA rules marked pending_confirmation stay out of the delay scorecard
-- ---------------------------------------------------------------------------------------------------------------------
-- 0059 body, plus: a late task whose rule is pending_confirmation (0052) counts in the total delay and in the items (the day is still late and still
-- unattributed or attributed), but not in the scorecard; scorecard_excluded_working_days and scorecard_excluded_tasks say how much was left out.
CREATE OR REPLACE FUNCTION dash_sec_delay(p_ref date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE out_ jsonb;
BEGIN
  WITH wm AS (
    -- the last day of each working-day count: the rebuilt due day is the last day whose count is the start's count plus the maximum (Q181)
    SELECT c.wd, max(c.d) AS d FROM _dcal c GROUP BY c.wd
  ), lt AS (
    SELECT t.id, t.site_id, t.days_over, t.external_party_id, t.default_party, coalesce(r.pending_confirmation, false) AS pend,
           coalesce(t.due_date, wm.d) AS due_d,
           CASE WHEN t.phase = 'open' THEN p_ref ELSE least(p_ref, coalesce(ti.sla_end_date, t.done_date, p_ref)) END AS end_d
    FROM _dtask t JOIN public.task_instances ti ON ti.id = t.id LEFT JOIN public.sla_rules r ON r.id = ti.sla_rule_id
    LEFT JOIN _dcal c0 ON t.due_date IS NULL AND c0.d = ti.sla_start_date
    LEFT JOIN wm ON t.due_date IS NULL AND wm.wd = c0.wd + r.max_working_days
    WHERE t.phase <> 'none' AND t.cls = 'late' AND t.days_over > 0
  ), dy AS (
    SELECT lt.id, lt.site_id, c.d FROM lt JOIN _dcal c ON c.is_wd AND c.d > lt.due_d AND c.d <= lt.end_d WHERE lt.due_d IS NOT NULL
  ), susp AS (
    SELECT s.site_id, coalesce(s.suspension_start, s.approval_date) AS f,
           (SELECT min(coalesce(x.resumption_date, x.approval_date)) FROM public.change_requests x
             WHERE x.site_id = s.site_id AND x.kind = 'resumption' AND x.status IN ('approved', 'applied')
               AND coalesce(x.resumption_date, x.approval_date) > coalesce(s.suspension_start, s.approval_date)) AS t
    FROM public.change_requests s
    WHERE s.kind = 'suspension' AND s.status IN ('approved', 'applied') AND coalesce(s.suspension_start, s.approval_date) <= p_ref
      AND s.site_id IN (SELECT site_id FROM lt)
  ), eff AS (
    SELECT p.* FROM public.task_delay_periods p
    WHERE p.task_id IN (SELECT id FROM lt) AND p.voided_at IS NULL AND p.status = 'approved' AND NOT (p.party IN ('contractor', 'external') AND p.external_party_id IS NULL)
  ), dd AS (
    SELECT dy.id, dy.site_id, dy.d,
      EXISTS (SELECT 1 FROM susp WHERE susp.site_id = dy.site_id AND dy.d >= susp.f AND (susp.t IS NULL OR dy.d < susp.t)) AS suspended,
      (SELECT e.id FROM eff e WHERE e.task_id = dy.id AND dy.d BETWEEN e.from_date AND e.to_date ORDER BY e.from_date, e.created_at LIMIT 1) AS period_id,
      EXISTS (SELECT 1 FROM public.task_delay_periods q WHERE q.task_id = dy.id AND q.voided_at IS NULL AND q.status = 'proposed' AND dy.d BETWEEN q.from_date AND q.to_date) AS proposed
    FROM dy
  ), rows_ AS (
    SELECT dd.id AS task_id, 1 AS wd, dd.suspended, dd.proposed, false AS gap, e.party AS period_party, e.external_party_id AS period_ext, lt.external_party_id, lt.default_party, lt.pend
    FROM dd JOIN lt ON lt.id = dd.id LEFT JOIN eff e ON e.id = dd.period_id
    UNION ALL
    SELECT lt.id, lt.days_over, false, false, true, NULL, NULL, lt.external_party_id, lt.default_party, lt.pend
    FROM lt WHERE NOT EXISTS (SELECT 1 FROM dy WHERE dy.id = lt.id)
  ), keyed AS (
    SELECT r.task_id, r.wd, r.suspended, r.proposed, r.gap, r.pend, r.period_party,
      CASE WHEN r.period_party IS NOT NULL THEN 'period:' || r.period_party || coalesce(':' || r.period_ext::text, '')
           WHEN r.gap THEN 'gap'
           WHEN r.external_party_id IS NOT NULL THEN 'un:party:' || r.external_party_id::text
           WHEN r.default_party IS NOT NULL THEN 'un:type:' || r.default_party ELSE 'un:none' END AS pkey,
      CASE WHEN r.period_party IS NOT NULL THEN 'period' ELSE 'unattributed' END AS kind,
      CASE WHEN r.period_party IS NOT NULL THEN coalesce(pe.name, r.period_party) ELSE 'unattributed' END AS party,
      CASE WHEN r.period_party IS NOT NULL THEN r.period_ext END AS ext_id,
      CASE WHEN r.period_party IS NOT NULL THEN pe.type::text END AS ptype,
      CASE WHEN r.period_party IS NULL AND NOT r.gap THEN coalesce(ep.name, r.default_party) END AS sparty,
      CASE WHEN r.period_party IS NULL AND NOT r.gap THEN r.external_party_id END AS sext,
      CASE WHEN r.period_party IS NULL AND NOT r.gap THEN CASE WHEN r.external_party_id IS NOT NULL THEN 'external' WHEN r.default_party IS NOT NULL THEN 'default_type' END END AS skind,
      CASE WHEN r.period_party IS NULL AND NOT r.gap THEN coalesce(ep.type::text, r.default_party) END AS stype
    FROM rows_ r LEFT JOIN public.external_parties ep ON ep.id = r.external_party_id LEFT JOIN public.external_parties pe ON pe.id = r.period_ext
  ), g AS (
    SELECT pkey, max(kind) AS kind, max(party) AS party, max(ext_id::text) AS external_party_id, max(ptype) AS ptype, max(period_party) AS period_party,
           max(sparty) AS sparty, max(sext::text) AS sext, max(skind) AS skind, max(stype) AS stype, bool_or(gap) AS gap,
           count(DISTINCT task_id) AS late_tasks, sum(wd) AS wd,
           coalesce(sum(wd) FILTER (WHERE NOT pend), 0) AS wd_sc, count(DISTINCT task_id) FILTER (WHERE NOT pend) AS late_tasks_sc
    FROM keyed WHERE NOT suspended GROUP BY pkey
  ), tot AS (
    SELECT coalesce(sum(wd), 0) AS wd, coalesce(sum(wd) FILTER (WHERE kind = 'unattributed'), 0) AS un, coalesce(sum(wd) FILTER (WHERE kind = 'period'), 0) AS per,
           coalesce(sum(wd) FILTER (WHERE gap), 0) AS gap,
           coalesce(sum(wd - wd_sc) FILTER (WHERE kind = 'period'), 0) AS sc_out FROM g
  )
  SELECT jsonb_build_object('total_late_working_days', tot.wd,
    'attributed_working_days', tot.per, 'period_working_days', tot.per, 'unattributed_working_days', tot.un, 'data_gap_working_days', tot.gap,
    'attributed_pct', CASE WHEN tot.wd > 0 THEN round(tot.per * 100.0 / tot.wd, 2) ELSE 0 END,
    'unattributed_pct', CASE WHEN tot.wd > 0 THEN round(tot.un * 100.0 / tot.wd, 2) ELSE 0 END,
    'proposed_working_days', (SELECT count(*) FROM keyed WHERE NOT suspended AND kind = 'unattributed' AND proposed),
    'overlapping_periods', 0, 'periods_supported', true,
    'suspended_working_days', (SELECT count(*) FROM keyed WHERE suspended),
    'periods_count', (SELECT count(*) FROM eff),
    'proposals_count', (SELECT count(*) FROM public.task_delay_periods p WHERE p.voided_at IS NULL AND p.status = 'proposed' AND p.task_id IN (SELECT id FROM lt)),
    'pending_party_count', (SELECT count(*) FROM public.task_delay_periods p WHERE p.voided_at IS NULL AND p.status = 'approved' AND p.party IN ('contractor', 'external')
                              AND p.external_party_id IS NULL AND p.task_id IN (SELECT id FROM lt)),
    'items', coalesce((SELECT jsonb_agg(jsonb_build_object('party', g.party, 'external_party_id', g.external_party_id, 'party_type', g.ptype, 'kind', g.kind,
        'period_party', g.period_party, 'data_gap', g.gap,
        'suggested_party', CASE WHEN g.sparty IS NOT NULL THEN jsonb_build_object('name', g.sparty, 'kind', g.skind, 'external_party_id', g.sext, 'party_type', g.stype) END,
        'late_tasks', g.late_tasks, 'late_working_days', g.wd, 'share_pct', round(g.wd * 100.0 / nullif(tot.wd, 0), 2))
        ORDER BY g.wd DESC, g.party, g.pkey) FROM g), '[]'::jsonb),
    'scorecard', coalesce((SELECT jsonb_agg(jsonb_build_object('party', g.party, 'period_party', g.period_party, 'external_party_id', g.external_party_id, 'party_type', g.ptype,
        'late_tasks', g.late_tasks_sc, 'late_working_days', g.wd_sc) ORDER BY g.wd_sc DESC, g.party) FROM g WHERE g.kind = 'period' AND g.wd_sc > 0), '[]'::jsonb),
    'scorecard_excluded_working_days', tot.sc_out,
    'scorecard_excluded_tasks', (SELECT count(DISTINCT k.task_id) FROM keyed k WHERE NOT k.suspended AND k.pend AND k.kind = 'period'))
  INTO out_ FROM tot;
  RETURN out_;
END $$;


-- ---------------------------------------------------------------------------------------------------------------------
-- 8. Q330: the certificate alert repeats every 7 days until the expiry date is renewed
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE contractor_alerts_sent
  ADD COLUMN last_sent_on DATE NOT NULL DEFAULT public.cal_today(),
  ADD COLUMN times INTEGER NOT NULL DEFAULT 1 CHECK (times >= 1);
UPDATE contractor_alerts_sent SET last_sent_on = (sent_at AT TIME ZONE coalesce(public.calc_setting('calc.timezone', '"Africa/Tripoli"'::jsonb) #>> '{}', 'Africa/Tripoli'))::date;
COMMENT ON COLUMN contractor_alerts_sent.last_sent_on IS '0068 (Q330): the day the alert was last sent; a safety certificate alert is sent again 7 days after it until the expiry date is renewed.';

CREATE OR REPLACE FUNCTION contractors_daily_alerts() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE cfg public.contractor_rules%ROWTYPE; today date := public.cal_today(); t record; o record; pr jsonb; stage text; u uuid; n integer := 0; ok boolean; nth integer;
  who uuid[]; lnk text;
BEGIN
  SELECT * INTO cfg FROM public.contractor_rules WHERE id;
  FOR t IN SELECT et.id, et.name, et.safety_cert_expiry AS exp, et.lead_user_id, et.source_record_id, ep.name AS pname
           FROM public.external_teams et JOIN public.external_parties ep ON ep.id = et.party_id
           WHERE et.is_active AND et.safety_cert_expiry IS NOT NULL AND et.safety_cert_expiry <= today + cfg.safety_cert_lead_days ORDER BY et.safety_cert_expiry, et.id LOOP
    stage := CASE WHEN t.exp < today THEN 'expired' ELSE 'due' END;
    -- Q330: the first alert of a stage goes out at once; the same alert repeats every 7 days until the expiry date is renewed (a new date is a new alert)
    nth := NULL;
    INSERT INTO public.contractor_alerts_sent (kind, ref_id, detail, last_sent_on, times) VALUES ('safety_cert_' || stage, t.id, t.exp::text, today, 1)
    ON CONFLICT (kind, ref_id, detail) DO UPDATE SET last_sent_on = today, times = contractor_alerts_sent.times + 1
      WHERE contractor_alerts_sent.last_sent_on <= today - 7
    RETURNING times INTO nth;
    IF nth IS NULL THEN CONTINUE; END IF;
    who := ARRAY(SELECT x FROM public.p4b_recipients(NULL) x UNION SELECT us.id FROM public.users us WHERE us.id = t.lead_user_id AND us.status = 'active' AND us.deleted_at IS NULL);
    IF cardinality(who) = 0 THEN who := ARRAY(SELECT public.p4b_admins()); END IF;
    lnk := CASE WHEN t.source_record_id IS NOT NULL THEN '/registers/contractors/records/' || t.source_record_id::text ELSE '/reports/contractors' END;
    FOREACH u IN ARRAY who LOOP
      INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
      VALUES (u, 'in_app', 'team_safety_cert', CASE WHEN nth > 1 THEN 'Reminder: ' ELSE '' END || CASE stage WHEN 'expired' THEN 'A team safety certificate has expired' ELSE 'A team safety certificate expires soon' END,
              t.name || ' (' || t.pname || '): the safety certificate ' || CASE stage WHEN 'expired' THEN 'expired on ' ELSE 'expires on ' END || t.exp::text
              || '. Information only: orders and assignments are not blocked (D145b).'
              || CASE WHEN nth > 1 THEN ' Weekly reminder ' || (nth - 1)::text || ': it repeats until the expiry date is renewed (Q330).' ELSE '' END, lnk);
      n := n + 1;
    END LOOP;
    ok := NULL;
  END LOOP;
  FOR o IN SELECT * FROM public.p4b_order_problems(today) LOOP
    FOR pr IN SELECT e FROM jsonb_array_elements(o.problems) e WHERE e ->> 'severity' = 'eligibility' LOOP
      INSERT INTO public.contractor_alerts_sent (kind, ref_id, detail) VALUES ('order_mismatch', o.entity_id, pr ->> 'code') ON CONFLICT DO NOTHING RETURNING true INTO ok;
      IF ok IS NULL THEN CONTINUE; END IF;
      who := ARRAY(SELECT public.p4b_recipients(o.region_id));
      IF cardinality(who) = 0 THEN who := ARRAY(SELECT public.p4b_recipients(NULL)); END IF;   -- nobody for the region: Procurement of any region
      IF cardinality(who) = 0 THEN who := ARRAY(SELECT public.p4b_admins()); END IF;
      FOREACH u IN ARRAY who LOOP
        INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
        VALUES (u, 'in_app', 'order_team_mismatch', 'A running order no longer matches its team or contract',
                coalesce((SELECT s.site_code FROM public.sites s WHERE s.id = o.site_id), '?') || ' / ' || coalesce(o.scope, '?') || ': ' || (pr ->> 'message')
                || ' See Reports, team / scope mismatch.', '/registers/procurement/records/' || o.record_id::text);
        n := n + 1;
      END LOOP;
      ok := NULL;
    END LOOP;
  END LOOP;
  RETURN n;
END $$;


-- ---------------------------------------------------------------------------------------------------------------------
-- 9. Ownership and rights
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT, UPDATE ON template_task_fields TO pmis_definer;
GRANT SELECT ON register_records, register_fields TO pmis_definer;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'severity_catalogue_guard()', 'sync_severity_catalogue()', 'snag_severities_changed()', 'qc_decide_evidence(uuid,uuid,boolean,text,boolean)',
    'qc_cancel_snag_record(uuid,integer,text,boolean)', 'tpl_task_field_list()', 'tpl_task_fields_refresh()', 'dash_sec_delay(date)', 'contractors_daily_alerts()'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    -- granted: the two API doors. Not granted: the mirror, the triggers, the dashboard section and the daily job (called by definer code only).
    FOREACH f IN ARRAY ARRAY['qc_decide_evidence(uuid,uuid,boolean,text,boolean)', 'qc_cancel_snag_record(uuid,integer,text,boolean)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
