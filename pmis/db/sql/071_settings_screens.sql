-- 0072_settings_screens: the settings screens of Q440 and Q441, and the decisions Q476 and Q477 (docs/spec/technical-decisions-2026-11-04.md, "Decided 2026-11-05 (2)").
-- Contract 0.14.2, CHANGELOG 101. Mirror: db/sql/071_settings_screens.sql (kept byte-identical).
--
--   1. Q440. The official calendar is confirmed (and unconfirmed) in Settings, Work calendar. admin_set_calendar_confirmation(confirmed, reason, version) sets the setting
--      calendar.official_confirmed (built in 0052, reset every 1 January by 0067). Who: a System Admin, or a delegate of `settings` edit (module `calendars`) for all
--      regions. A reason and If-Match are required; the change is audited through log_audit_write (calendar_official_confirmed / calendar_official_unconfirmed) with the
--      state before and after. Confirming is refused while the current or the next year has no holiday, or a holiday of those years is still tentative (the owner
--      recommendation of Q440). cal_confirmation_json() reads the state: confirmed, who, when, the ETag, whether the caller may edit, and the blockers.
--      The setting keeps its boolean value (the calendar code reads it as one): the ETag is derived from the row (settings_etag), so it also moves with the yearly
--      reset and with a change made in the database.
--   2. Q441. The mail notification kinds (setting mail.notification_kinds, 0055) are edited in Settings by a System Admin only. mail_kind_catalogue() lists the kinds the
--      code writes today (the six go-live kinds of tools/install/README.md are marked recommended), mail_kind_reserved() the kinds reserved for security.
--      admin_save_mail_kinds(kinds, reason, version) needs a System Admin, a reason, step-up (the verified context, app_ctx_stepup()) and the version; it refuses an
--      unknown kind, a reserved kind, a duplicate and a malformed value with field errors, and writes an audit row (mail_notification_kinds_update). mail_kinds_json()
--      reads it (System Admin only).
--   3. Q476. p4a_feed_rf (latest definition: 0062) writes sites.latitude and sites.longitude only while the site has no coordinates. Once a site has coordinates they
--      change only through a Change Control proposal (0071). When the feed fills them it writes an audit row (site_coordinates_fed); when the record names other
--      coordinates than the site holds, an audit row says they were not applied (site_coordinates_kept). Every other part of the feed is as it was in 0062.
--   4. Q477. si_apply_identity (latest definition: 0071) tells the Team Leads of the new region when an approved move takes a site there: the holders of the `reassign`
--      grant (B12b) who can see the site, and the System Admins when nobody holds it. The in-app notice (kind site_region_moved) lists the site and its open tasks with
--      their holders. Open tasks keep their holders and their SLA: nothing is reassigned or reset.
--
--   5. The two settings are changed only through those functions. settings has row-level policies (an administrator may write), so an administrator's own session could still
--      update the rows directly, without the reason, the step-up, the version check or the audit row. A trigger on the two keys refuses any writer but the definer
--      functions (and the migration role, so the installer's SQL still works): 42501. It runs as the caller by design (it must see who runs the statement), like
--      sites_identity_guard (0071).
--
-- Every new function is SECURITY DEFINER with search_path = pg_catalog, public, pg_temp, owned by pmis_definer, PUBLIC revoked. The actor, the regions and the step-up
-- come from the context accessors (app_actor(), app_ctx_stepup()), never from a setting read by hand. pmis_app stays read-only on the tables; it only calls the four
-- entry points (cal_confirmation_json, admin_set_calendar_confirmation, mail_kinds_json, admin_save_mail_kinds).

SELECT set_config('app.region_ids', '*', true);

-- ---------------------------------------------------------------------------------------------------------------------
-- 0. Rights of the definer role for what the new functions read and write
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT ON settings, holidays, work_calendars, users, groups, group_members, roles, task_instances, task_definitions, regions, sites,
  user_role_assignments, user_role_assignment_regions, user_role_assignment_modules, user_role_assignment_profiles, permission_profiles, permission_grants,
  delegations, delegation_regions TO pmis_definer;
GRANT INSERT, UPDATE ON settings TO pmis_definer;
GRANT INSERT ON notifications TO pmis_definer;

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. A version (ETag) for a setting row that has no version column: 28 bits of a hash of its value and its last change (an integer of at most 9 digits)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION settings_etag(p_key text) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce((SELECT ('x' || substr(md5(s.value::text || '|' || extract(epoch FROM s.updated_at)::text), 1, 7))::bit(28)::int
                   FROM public.settings s WHERE s.key = p_key), 0)
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Q440: the official calendar confirmation
-- ---------------------------------------------------------------------------------------------------------------------
-- The state: {confirmed, confirmed_at, confirmed_by, version, can_edit, blockers[]}. A confirmation made in the database (no person) has confirmed_by null.
CREATE OR REPLACE FUNCTION cal_confirmation_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  s public.settings%ROWTYPE; conf boolean; y integer := extract(year FROM public.cal_today())::integer; yr integer; n_all bigint; n_tent bigint;
  blockers jsonb := '[]'::jsonb; cal uuid;
BEGIN
  SELECT * INTO s FROM public.settings WHERE key = 'calendar.official_confirmed';
  conf := coalesce(jsonb_typeof(s.value) = 'boolean' AND (s.value #>> '{}')::boolean, false);
  SELECT id INTO cal FROM public.work_calendars WHERE is_default AND is_active ORDER BY code LIMIT 1;
  FOREACH yr IN ARRAY ARRAY[y, y + 1] LOOP
    SELECT count(*), count(*) FILTER (WHERE h.tentative) INTO n_all, n_tent
    FROM public.holidays h WHERE (cal IS NULL OR h.calendar_id = cal) AND extract(year FROM h.date) = yr;
    IF n_all = 0 THEN blockers := blockers || jsonb_build_object('code', 'no_holidays', 'year', yr, 'count', 0);
    ELSIF n_tent > 0 THEN blockers := blockers || jsonb_build_object('code', 'tentative_remaining', 'year', yr, 'count', n_tent); END IF;
  END LOOP;
  RETURN jsonb_build_object(
    'confirmed', conf,
    'confirmed_at', CASE WHEN conf THEN to_jsonb(s.updated_at) ELSE 'null'::jsonb END,
    'confirmed_by', CASE WHEN conf AND s.updated_by IS NOT NULL THEN to_jsonb(s.updated_by) ELSE 'null'::jsonb END,
    'version', public.settings_etag('calendar.official_confirmed'),
    'can_edit', (public.app_actor_is_admin('calendars', 'edit') AND public.app_actor_region_filter('calendars', 'edit') IS NULL),
    'blockers', blockers);
END $$;

CREATE OR REPLACE FUNCTION admin_set_calendar_confirmation(p_confirmed boolean, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; blockers jsonb; b jsonb; errs jsonb := '[]'::jsonb; before_ jsonb; after_ jsonb; res jsonb;
BEGIN
  PERFORM public.calc_require_admin('calendars', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_confirmed IS NULL THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/confirmed', 'required', 'true or false.')));
  END IF;
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('calendar.official_confirmed', 'false'::jsonb, 'Q4: true once the official Libyan holiday calendar for the current and next year has been entered and confirmed.', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'calendar.official_confirmed' FOR UPDATE;
  cur := public.cal_confirmation_json();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF (cur ->> 'confirmed')::boolean = p_confirmed THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail',
      CASE WHEN p_confirmed THEN 'The official calendar is already confirmed.' ELSE 'The official calendar is not confirmed.' END));
  END IF;
  IF p_confirmed THEN
    blockers := cur -> 'blockers';
    FOR b IN SELECT * FROM jsonb_array_elements(blockers) LOOP
      errs := errs || public.reg_err_item('/confirmed', b ->> 'code',
        CASE WHEN b ->> 'code' = 'no_holidays' THEN 'The calendar has no holiday for ' || (b ->> 'year') || '.'
             ELSE (b ->> 'count') || ' holiday(s) of ' || (b ->> 'year') || ' are still tentative: confirm them first.' END);
    END LOOP;
    IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  END IF;
  before_ := jsonb_build_object('confirmed', cur -> 'confirmed', 'confirmed_at', cur -> 'confirmed_at', 'confirmed_by', cur -> 'confirmed_by');
  UPDATE public.settings SET value = to_jsonb(p_confirmed), updated_by = public.app_actor(), updated_at = clock_timestamp() WHERE key = 'calendar.official_confirmed';
  res := public.cal_confirmation_json();
  after_ := jsonb_build_object('confirmed', res -> 'confirmed', 'confirmed_at', res -> 'confirmed_at', 'confirmed_by', res -> 'confirmed_by');
  PERFORM public.log_audit_write(CASE WHEN p_confirmed THEN 'calendar_official_confirmed' ELSE 'calendar_official_unconfirmed' END,
    'setting', 'calendar.official_confirmed', before_, after_, btrim(p_reason));
  RETURN res;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Q441: the mail notification kinds
-- ---------------------------------------------------------------------------------------------------------------------
-- The kinds the code writes today and that can be mailed. The first six are the go-live kinds of tools/install/README.md (a person is asked to act). Not listed:
-- security_alert and security_notice (reserved, mailed by their own rules), system (the notice about a failed mail is never mailed), and the kinds of the contract's
-- list that nothing writes yet (task_returned, approval_due, ...): they are added here by the release that starts writing them (tests/ the catalogue test check it).
CREATE OR REPLACE FUNCTION mail_kind_catalogue() RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_agg(jsonb_build_object('kind', k, 'recommended', ord <= 6) ORDER BY ord)
  FROM unnest(ARRAY[
    'task_assigned', 'register_assigned', 'snag_review', 'task_rejected', 'register_rejected', 'snag_rejected',
    'email_change_decided', 'email_change_requested', 'followed_change', 'gate_closed_again', 'holiday_tentative', 'import_batch', 'levels_converted', 'mention',
    'no_eligible_holder', 'order_team_mismatch', 'party_type_review', 'permit_transferred', 'phone_change_decided', 'phone_change_requested', 'site_draft_approved',
    'site_draft_assigned', 'site_draft_returned', 'site_region_moved', 'sla_negative_duration', 'snag_closed', 'snag_raised', 'team_safety_cert'
  ]) WITH ORDINALITY AS t(k, ord)
$$;

-- Kinds reserved for security: they are never put on the list (security alerts and the integrity hash are mailed by their own mandatory rules).
CREATE OR REPLACE FUNCTION mail_kind_reserved(p_kind text) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(p_kind ~ '^(security_|integrity_|audit_integrity|break_glass|retention_)', false)
$$;

CREATE OR REPLACE FUNCTION mail_kinds_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE; kinds jsonb; unknown jsonb;
BEGIN
  IF NOT public.app_actor_is_system_admin() THEN RAISE EXCEPTION 'mail kinds: System Admin only' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'mail.notification_kinds';
  kinds := CASE WHEN jsonb_typeof(s.value) = 'array' THEN
             coalesce((SELECT jsonb_agg(e) FROM jsonb_array_elements(s.value) e WHERE jsonb_typeof(e) = 'string'), '[]'::jsonb) ELSE '[]'::jsonb END;
  unknown := coalesce((SELECT jsonb_agg(e) FROM jsonb_array_elements(kinds) e
                       WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(public.mail_kind_catalogue()) c WHERE c ->> 'kind' = e #>> '{}')), '[]'::jsonb);
  RETURN jsonb_build_object('kinds', kinds, 'unknown_kinds', unknown, 'catalogue', public.mail_kind_catalogue(), 'version', public.settings_etag('mail.notification_kinds'),
    'updated_at', CASE WHEN s.key IS NULL THEN 'null'::jsonb ELSE to_jsonb(s.updated_at) END,
    'updated_by', CASE WHEN s.updated_by IS NULL THEN 'null'::jsonb ELSE to_jsonb(s.updated_by) END);
END $$;

CREATE OR REPLACE FUNCTION admin_save_mail_kinds(p_kinds jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  cur jsonb; el jsonb; k text; i integer := 0; errs jsonb := '[]'::jsonb; seen text[] := ARRAY[]::text[]; clean text[] := ARRAY[]::text[]; before_ jsonb; after_ jsonb; res jsonb;
BEGIN
  IF NOT public.app_actor_is_system_admin() THEN RAISE EXCEPTION 'mail kinds: System Admin only' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM public.calc_require_reason(p_reason);
  IF NOT public.app_ctx_stepup() THEN PERFORM public.wf_err('step_up_required'); END IF;
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('mail.notification_kinds', '[]'::jsonb, 'Notification kinds that are also sent by mail to the recipient. Security alerts are mailed by their own rule.', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'mail.notification_kinds' FOR UPDATE;
  cur := public.mail_kinds_json();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF p_kinds IS NULL OR jsonb_typeof(p_kinds) <> 'array' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/kinds', 'invalid', 'A list of notification kinds.')));
  END IF;
  IF jsonb_array_length(p_kinds) > 100 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/kinds', 'too_many', 'At most 100 kinds.')));
  END IF;
  FOR el IN SELECT * FROM jsonb_array_elements(p_kinds) LOOP
    IF jsonb_typeof(el) <> 'string' OR (el #>> '{}') !~ '^[a-z][a-z0-9_]{1,59}$' THEN
      errs := errs || public.reg_err_item('/kinds/' || i, 'invalid', 'A notification kind is a lower-case code.');
    ELSE
      k := el #>> '{}';
      IF public.mail_kind_reserved(k) THEN
        errs := errs || public.reg_err_item('/kinds/' || i, 'reserved_kind', 'This kind is reserved for security and is mailed by its own rule.');
      ELSIF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(public.mail_kind_catalogue()) c WHERE c ->> 'kind' = k) THEN
        errs := errs || public.reg_err_item('/kinds/' || i, 'unknown_kind', 'The system writes no notification of this kind.');
      ELSIF k = ANY (seen) THEN
        errs := errs || public.reg_err_item('/kinds/' || i, 'duplicate', 'This kind is listed twice.');
      ELSE
        clean := clean || k;
      END IF;
      seen := seen || k;
    END IF;
    i := i + 1;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  before_ := jsonb_build_object('kinds', cur -> 'kinds');
  UPDATE public.settings SET value = coalesce((SELECT jsonb_agg(x ORDER BY x) FROM unnest(clean) x), '[]'::jsonb), updated_by = public.app_actor(), updated_at = clock_timestamp()
  WHERE key = 'mail.notification_kinds';
  res := public.mail_kinds_json();
  after_ := jsonb_build_object('kinds', res -> 'kinds');
  PERFORM public.log_audit_write('mail_notification_kinds_update', 'setting', 'mail.notification_kinds', before_, after_, btrim(p_reason));
  RETURN res;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Q476: the RF & Design feed fills the coordinates only while the site has none (latest definition: 0062; only the coordinates and their audit change)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION p4a_feed_rf(p_record uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.register_records%ROWTYPE; d jsonb; s public.sites%ROWTYPE; s2 public.sites%ROWTYPE; scen text; changed jsonb := '{}'::jsonb; c text;
  new_lat numeric; new_lon numeric; fill boolean;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  d := r.data;
  INSERT INTO public.rf_design_records (id, site_id, region_id, nominal_plan_issue_date, nominal_lat, nominal_lon, search_ring_radius_m, search_ring_received_date,
    antenna_height_m, sectors, azimuths, tilt, tss_plan_date, custom, register_record_id, record_version)
  VALUES (r.entity_id, r.site_id, r.region_id, public.p4a_date(d ->> 'nominal_plan_issue_date'), public.p4a_num(d -> 'nominal_latitude'), public.p4a_num(d -> 'nominal_longitude'),
    round(public.p4a_num(d -> 'search_ring_radius'))::int, public.p4a_date(d ->> 'search_ring_received'), public.p4a_num(d -> 'antenna_height'), round(public.p4a_num(d -> 'sectors'))::int,
    d ->> 'azimuths', d ->> 'tilt', public.p4a_date(d ->> 'tss_plan'), r.custom, r.id, r.version_no)
  ON CONFLICT (id) DO UPDATE SET nominal_plan_issue_date = EXCLUDED.nominal_plan_issue_date, nominal_lat = EXCLUDED.nominal_lat, nominal_lon = EXCLUDED.nominal_lon,
    search_ring_radius_m = EXCLUDED.search_ring_radius_m, search_ring_received_date = EXCLUDED.search_ring_received_date, antenna_height_m = EXCLUDED.antenna_height_m,
    sectors = EXCLUDED.sectors, azimuths = EXCLUDED.azimuths, tilt = EXCLUDED.tilt, tss_plan_date = EXCLUDED.tss_plan_date, custom = EXCLUDED.custom,
    register_record_id = EXCLUDED.register_record_id, record_version = EXCLUDED.record_version;
  -- the site identity (Master C:Q): only the values the record holds; an empty value never clears the site
  SELECT * INTO s FROM public.sites WHERE id = r.site_id FOR UPDATE;
  scen := d ->> 'site_scenario';
  -- Q476: the surveyed coordinates are written only while the site has none (a pair, in range); afterwards they change through a Change Control proposal only
  new_lat := public.p4a_num(d -> 'latitude');
  new_lon := public.p4a_num(d -> 'longitude');
  fill := s.latitude IS NULL AND s.longitude IS NULL AND new_lat IS NOT NULL AND new_lon IS NOT NULL AND abs(new_lat) <= 90 AND abs(new_lon) <= 180;
  UPDATE public.sites SET
    owner_site_id = coalesce(d ->> 'site_owner_id', owner_site_id), sub_region = coalesce(d ->> 'sub_region', sub_region),
    latitude = CASE WHEN fill THEN round(new_lat, 6) ELSE latitude END, longitude = CASE WHEN fill THEN round(new_lon, 6) ELSE longitude END,
    site_type = coalesce(d ->> 'site_type', site_type), site_scenario = coalesce(scen, site_scenario),
    delivery_scenario = CASE WHEN scen IN ('New Build', 'Expansion', 'Hot Swap', 'Cold Swap', 'Relocation') THEN replace(lower(scen), ' ', '_')::"DeliveryScenario" ELSE delivery_scenario END,
    tower_owner = coalesce(d ->> 'tower_owner', tower_owner), existing_or_new = coalesce(d ->> 'existing_or_new', existing_or_new), rt_or_gf = coalesce(d ->> 'rt_or_gf', rt_or_gf),
    tower_type = coalesce(d ->> 'tower_type', tower_type), tower_height_m = coalesce(public.p4a_num(d -> 'tower_height'), tower_height_m),
    rf_survey_date = coalesce(public.p4a_date(d ->> 'rf_survey_actual_date'), rf_survey_date)
  WHERE id = r.site_id RETURNING * INTO s2;
  FOREACH c IN ARRAY ARRAY['owner_site_id', 'sub_region', 'latitude', 'longitude', 'site_type', 'site_scenario', 'delivery_scenario', 'tower_owner', 'existing_or_new', 'rt_or_gf',
                           'tower_type', 'tower_height_m', 'rf_survey_date'] LOOP
    IF (to_jsonb(s) -> c) IS DISTINCT FROM (to_jsonb(s2) -> c) THEN changed := changed || jsonb_build_object(c, jsonb_build_object('before', to_jsonb(s) -> c, 'after', to_jsonb(s2) -> c)); END IF;
  END LOOP;
  IF fill THEN
    PERFORM public.p4a_audit('site_coordinates_fed', 'site', r.site_id::text, jsonb_build_object('latitude', NULL, 'longitude', NULL),
      jsonb_build_object('latitude', s2.latitude, 'longitude', s2.longitude, 'record_id', r.id),
      'approved RF & Design record version ' || r.version_no || ': the site had no coordinates (Q476)', r.site_id, r.region_id);
  ELSIF new_lat IS NOT NULL AND new_lon IS NOT NULL AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL
        AND (round(new_lat, 6), round(new_lon, 6)) IS DISTINCT FROM (s.latitude, s.longitude) THEN
    PERFORM public.p4a_audit('site_coordinates_kept', 'site', r.site_id::text, jsonb_build_object('latitude', s.latitude, 'longitude', s.longitude),
      jsonb_build_object('latitude', new_lat, 'longitude', new_lon, 'record_id', r.id, 'applied', false),
      'approved RF & Design record version ' || r.version_no || ': the site already has coordinates; they change only through a Change Control proposal (Q476)', r.site_id, r.region_id);
  END IF;
  IF changed <> '{}'::jsonb THEN
    UPDATE public.sites SET updated_at = clock_timestamp() WHERE id = r.site_id;
    PERFORM public.p4a_audit('site_identity_fed', 'site', r.site_id::text, NULL, jsonb_build_object('changes', changed, 'record_id', r.id),
      'approved RF & Design record version ' || r.version_no, r.site_id, r.region_id);
    IF changed ? 'delivery_scenario' THEN PERFORM public.p4a_hook('wf_apply_applicability', r.site_id); END IF;
    PERFORM public.calc_refresh_site(r.site_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Q477: the Team Leads of the new region are told when a site moves there
-- ---------------------------------------------------------------------------------------------------------------------
-- Does the person hold the `reassign` grant (B12b: module overrides.reassign, action administer) for the region? Through an active assignment whose profile carries
-- the grant, limited to its regions and modules like wf_actor_regions (decision B3), or through a delegation of it.
CREATE OR REPLACE FUNCTION ss_holds_reassign(p_user uuid, p_region integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_role_assignments ua
    WHERE ua.user_id = p_user AND ua.valid_from <= now() AND (ua.valid_to IS NULL OR ua.valid_to > now())
      AND (ua.all_regions OR EXISTS (SELECT 1 FROM public.user_role_assignment_regions r WHERE r.assignment_id = ua.id AND r.region_id = p_region))
      AND EXISTS (SELECT 1 FROM public.user_role_assignment_profiles ap
                  JOIN public.permission_profiles pp ON pp.id = ap.profile_id AND pp.is_active
                  JOIN public.permission_grants g ON g.profile_id = pp.id AND g.action = 'administer'
                  WHERE ap.assignment_id = ua.id AND ('overrides.reassign' = g.module_key OR 'overrides.reassign' LIKE g.module_key || '.%')
                    AND (ua.all_modules OR EXISTS (SELECT 1 FROM public.user_role_assignment_modules m WHERE m.assignment_id = ua.id AND m.module_key = split_part(g.module_key, '.', 1))))
  ) OR EXISTS (
    SELECT 1 FROM public.app_user_delegations(p_user) x(id) JOIN public.delegations d ON d.id = x.id
    WHERE public.deleg_covers(d.id, 'overrides.reassign', 'administer')
      AND (d.all_regions OR EXISTS (SELECT 1 FROM public.delegation_regions dr WHERE dr.delegation_id = d.id AND dr.region_id = p_region))
  )
$$;

-- Sends the notice and audits it. Returns {recipients, open_tasks, fallback}. Nothing is reassigned, nothing resets (B12b): the tasks keep their holders and SLA.
CREATE OR REPLACE FUNCTION ss_notify_region_move(p_site uuid, p_from integer, p_to integer, p_record uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  s public.sites%ROWTYPE; from_name text; to_name text; n_open integer; lines text; body text; recipients uuid[]; fallback boolean := false; u uuid;
BEGIN
  SELECT * INTO s FROM public.sites WHERE id = p_site;
  SELECT coalesce(r.name_en, r.code) INTO from_name FROM public.regions r WHERE r.id = p_from;
  SELECT coalesce(r.name_en, r.code) INTO to_name FROM public.regions r WHERE r.id = p_to;
  WITH o AS (
    SELECT td.code, td.name_en, t.state::text AS state,
           coalesce((SELECT us.display_name || coalesce(' (' || btrim(us.employee_id) || ')', '') FROM public.users us WHERE us.id = t.ball_in_court_user_id),
                    (SELECT 'group ' || g.name FROM public.groups g WHERE g.id = t.ball_in_court_group_id),
                    (SELECT 'role ' || ro.name_en FROM public.roles ro WHERE ro.id = t.ball_in_court_role_id), 'nobody yet') AS holder,
           row_number() OVER (ORDER BY td.sort_order, td.code) AS rn
    FROM public.task_instances t JOIN public.task_definitions td ON td.id = t.task_def_id
    WHERE t.site_id = p_site AND t.state IN ('open', 'entry', 'in_review', 'in_approval', 'rejected', 'suspended')
  )
  SELECT count(*), string_agg('- ' || o.code || ' ' || o.name_en || ' [' || o.state || '], with ' || o.holder, E'\n' ORDER BY o.rn) FILTER (WHERE o.rn <= 25)
    INTO n_open, lines FROM o;
  body := s.site_code || ' moved from ' || coalesce(from_name, '?') || ' to ' || coalesce(to_name, '?') || '. '
    || CASE WHEN n_open = 0 THEN 'It has no open task.'
            ELSE n_open || ' open task(s) keep their holders and their SLA; nothing was reassigned. For each one you can keep the person, reassign it, or act on it yourself.' || E'\n' || lines
                 || CASE WHEN n_open > 25 THEN E'\n' || '... and ' || (n_open - 25) || ' more.' ELSE '' END END;
  SELECT coalesce(array_agg(u2.id), ARRAY[]::uuid[]) INTO recipients
  FROM public.users u2 WHERE public.ss_holds_reassign(u2.id, p_to) AND public.wf_user_in_scope(u2.id, p_to);
  IF cardinality(recipients) = 0 THEN
    -- nobody holds the grant for the region: the System Admins decide (B12b), so the notice is not lost
    fallback := true;
    SELECT coalesce(array_agg(DISTINCT gm.user_id), ARRAY[]::uuid[]) INTO recipients
    FROM public.group_members gm JOIN public.groups g ON g.id = gm.group_id AND g.is_system_admins AND g.is_active
         JOIN public.users x ON x.id = gm.user_id AND x.status = 'active' AND x.deleted_at IS NULL AND NOT x.is_break_glass;
  END IF;
  FOREACH u IN ARRAY recipients LOOP
    INSERT INTO public.notifications (user_id, channel, kind, title, body, link, region_id, module_key)
    VALUES (u, 'in_app', 'site_region_moved', 'A site moved to your region: ' || s.site_code, left(body, 6000), '/sites/' || p_site::text, p_to, 'sites');
  END LOOP;
  PERFORM public.p4a_audit('site_region_move_notified', 'site', p_site::text, NULL,
    jsonb_build_object('from_region_id', p_from, 'to_region_id', p_to, 'recipients', cardinality(recipients), 'open_tasks', n_open, 'fallback_to_system_admins', fallback, 'record_id', p_record),
    'approved region move (Q477): the open tasks keep their holders and SLA; the leads of the new region were told (B12b)', p_site, p_to);
  RETURN jsonb_build_object('recipients', cardinality(recipients), 'open_tasks', n_open, 'fallback', fallback);
END $$;

-- Applies an approved identity change (latest definition: 0071). Only the notice of Q477 is new: after a move to another region the leads of the new region are told.
CREATE OR REPLACE FUNCTION si_apply_identity(p_record uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.register_records%ROWTYPE; item text; v jsonb; s public.sites%ROWTYPE; before_ text; after_ text; cols_b jsonb; cols_a jsonb; res jsonb; why text; new_region int;
  moved boolean := false;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  item := r.data ->> 'field_item';
  IF item IN ('site.region', 'site.cluster') THEN PERFORM public.si_require_admin('the region or the cluster'); END IF;
  SELECT * INTO s FROM public.sites WHERE id = r.site_id FOR UPDATE;
  before_ := public.p4a_site_current(r.site_id, item);
  cols_b := public.si_site_cols(r.site_id, item);
  v := public.p4a_site_parse(r.site_id, item, r.data ->> 'new_value');
  IF item = 'site.name' THEN
    UPDATE public.sites SET name = v #>> '{}', updated_at = clock_timestamp() WHERE id = r.site_id;
  ELSIF item = 'site.name_ar' THEN
    UPDATE public.sites SET name_ar = CASE WHEN v = 'null'::jsonb THEN NULL ELSE v #>> '{}' END, updated_at = clock_timestamp() WHERE id = r.site_id;
  ELSIF item = 'site.coordinates' THEN
    UPDATE public.sites SET latitude = (v ->> 'latitude')::numeric, longitude = (v ->> 'longitude')::numeric, updated_at = clock_timestamp() WHERE id = r.site_id;
  ELSIF item = 'site.region' THEN
    new_region := (v ->> 'region_id')::int;
    UPDATE public.sites SET region_id = new_region, cluster_id = (v ->> 'cluster_id')::uuid, updated_at = clock_timestamp() WHERE id = r.site_id;
  ELSE
    UPDATE public.sites SET cluster_id = (v ->> 'cluster_id')::uuid, updated_at = clock_timestamp() WHERE id = r.site_id;
  END IF;
  after_ := public.p4a_site_current(r.site_id, item);
  cols_a := public.si_site_cols(r.site_id, item);
  why := 'approved Change Control ' || coalesce(r.data ->> 'change_id', r.id::text) || ' (Q473)';
  res := jsonb_build_object('field', item, 'before', before_, 'after', after_, 'record_id', r.id, 'columns_before', cols_b, 'columns_after', cols_a);
  PERFORM public.p4a_audit('site_change_applied', 'site', r.site_id::text, jsonb_build_object('field', item, 'value', before_, 'columns', cols_b), res, why, r.site_id,
    coalesce(new_region, s.region_id));
  IF item = 'site.region' AND new_region IS DISTINCT FROM s.region_id THEN
    moved := true;
    -- the lead of the old region sees the move too (the audit log is read by region)
    PERFORM public.p4a_audit('site_region_moved_out', 'site', r.site_id::text, jsonb_build_object('field', item, 'value', before_, 'columns', cols_b), res, why, r.site_id, s.region_id);
  END IF;
  PERFORM public.calc_refresh_site(r.site_id);
  -- Q477: open tasks keep their holders and SLA (B12b); the leads of the new region are told at once, with the open tasks, so they can use the B12b choices
  IF moved THEN PERFORM public.ss_notify_region_move(r.site_id, s.region_id, new_region, r.id); END IF;
  RETURN res;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. The two settings change only through their audited functions
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION settings_guarded_keys() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT public.app_in_admin_path() THEN
    RAISE EXCEPTION 'permission denied: the setting % changes only through its audited function (migration 0072)', coalesce(NEW.key, OLD.key) USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER b_settings_guarded_keys BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key IN ('calendar.official_confirmed', 'mail.notification_kinds')) EXECUTE FUNCTION settings_guarded_keys();
-- an UPDATE is guarded when either the old or the new key is guarded, so a guarded row cannot be renamed away (security review 2026-11-05)
CREATE TRIGGER b_settings_guarded_keys_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key IN ('calendar.official_confirmed', 'mail.notification_kinds') OR NEW.key IN ('calendar.official_confirmed', 'mail.notification_kinds'))
  EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_guarded_keys_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key IN ('calendar.official_confirmed', 'mail.notification_kinds')) EXECUTE FUNCTION settings_guarded_keys();

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Ownership and rights
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('settings_screens_applied', 'workflow', NULL,
        jsonb_build_object('q440', 'calendar.official_confirmed is confirmed in Settings (admin_set_calendar_confirmation)', 'q441', 'mail.notification_kinds is edited in Settings (admin_save_mail_kinds)',
                           'q476', 'p4a_feed_rf fills the coordinates only while the site has none', 'q477', 'si_apply_identity tells the leads of the new region'),
        'Technical decisions Q440, Q441, Q476, Q477 (2026-11-05), migration 0072.');

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'settings_etag(text)', 'cal_confirmation_json()', 'admin_set_calendar_confirmation(boolean,text,integer)', 'mail_kind_catalogue()', 'mail_kind_reserved(text)',
    'mail_kinds_json()', 'admin_save_mail_kinds(jsonb,text,integer)', 'p4a_feed_rf(uuid)', 'ss_holds_reassign(uuid,integer)', 'ss_notify_region_move(uuid,integer,integer,uuid)',
    'si_apply_identity(uuid)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY['cal_confirmation_json()', 'admin_set_calendar_confirmation(boolean,text,integer)', 'mail_kinds_json()', 'admin_save_mail_kinds(jsonb,text,integer)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
