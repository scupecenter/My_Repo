-- 0360 (A3): expiry radar, IN-APP NOTIFICATION ONLY.
--
-- WHAT. expiry_radar_notify(p_day) writes an in-app notice when a register date that ends something is close: permits_hse.valid_to, acquisition.lease_expiry_date,
-- gecol.billing_conversion_date. The daily job calls it. It changes no record, no assignment, no permission and no date.
-- LEAD TIMES (settings). The setting `expiry.radar` is a JSON object {"enabled": true, "version": 0, "registers": {"<register_key>": {"field": "<date field>", "lead_days": [30, 14, 7]}}}.
-- Defaults: 30, 14 and 7 days for the three registers above. A register is added by adding it to the setting (a later Settings screen edits it, item E6).
-- WHO GETS IT. The holders of the register's Matrix row for the record's region (levels 1, 2 and 3: reg_cell_row + reg_eligible_cell), so nothing is hard-coded and a person
-- who is not in the Matrix row gets nothing. Active people only (reg_user_in_scope).
-- WHICH RECORDS. The current approved version of a logical record (is_current, state approved), not voided, with a date between today and today + the largest lead time.
-- ONE NOTICE PER STEP. A record gets one notice for the tightest lead step it has reached (a record first seen 10 days before expiry gets the 14-day notice, then the 7-day one).
-- A record whose date changed gets a new notice because the date is in the notice title. Expired dates (before today) get nothing: they are in the register already.
-- E-MAIL. The kind `expiry_radar` is mailed only if an admin adds it to the setting mail.notification_kinds; until then it is in the bell only.
-- SAFE TO REPEAT. Returns the number of notices written (an integer).

INSERT INTO settings (key, value, description, updated_at)
VALUES ('expiry.radar',
        '{"enabled": true, "version": 0, "registers": {"permits_hse": {"field": "valid_to", "lead_days": [30, 14, 7]}, "acquisition": {"field": "lease_expiry_date", "lead_days": [30, 14, 7]}, "gecol": {"field": "billing_conversion_date", "lead_days": [30, 14, 7]}}}'::jsonb,
        'A3: in-app notice to the Matrix holders of a register when a date that ends something (permit valid to, lease expiry, billing conversion) is within each lead time (days).',
        now())
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION expiry_radar_notify(p_day date DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  d date := coalesce(p_day, public.cal_today());
  cfg jsonb; reg record; rec record; lead integer; leads integer[]; tier integer; days_left integer;
  v_title text; n integer := 0; u record; cell uuid; lvl text; rows_n integer;
BEGIN
  SELECT value INTO cfg FROM public.settings WHERE key = 'expiry.radar';
  IF cfg IS NULL OR jsonb_typeof(cfg) <> 'object' OR coalesce((cfg ->> 'enabled')::boolean, true) IS NOT TRUE OR jsonb_typeof(cfg -> 'registers') <> 'object' THEN RETURN 0; END IF;
  FOR reg IN SELECT e.key AS register_key, e.value AS v FROM jsonb_each(cfg -> 'registers') e LOOP
    IF jsonb_typeof(reg.v) <> 'object' OR jsonb_typeof(reg.v -> 'lead_days') <> 'array' OR coalesce(reg.v ->> 'field', '') !~ '^[a-z][a-z0-9_]{0,40}$' THEN CONTINUE; END IF;
    SELECT coalesce(array_agg(x::integer ORDER BY x::integer), ARRAY[]::integer[]) INTO leads
      FROM jsonb_array_elements_text(reg.v -> 'lead_days') x WHERE x ~ '^[0-9]{1,3}$';
    IF coalesce(array_length(leads, 1), 0) = 0 THEN CONTINUE; END IF;
    FOR rec IN
      SELECT r.id, r.register_key, r.region_id, (r.data ->> (reg.v ->> 'field'))::date AS dt, public.reg_label(r.id) AS label
      FROM public.register_records r
      WHERE r.register_key = reg.register_key AND r.is_current AND r.state = 'approved'
        AND (r.data ->> (reg.v ->> 'field')) ~ '^\d{4}-\d{2}-\d{2}$'
        AND (r.data ->> (reg.v ->> 'field'))::date BETWEEN d AND d + leads[array_length(leads, 1)]
    LOOP
      days_left := rec.dt - d;
      tier := NULL;
      FOREACH lead IN ARRAY leads LOOP IF lead >= days_left THEN tier := lead; EXIT; END IF; END LOOP;
      IF tier IS NULL THEN CONTINUE; END IF;
      v_title := 'Expiry in ' || tier::text || ' days or less: ' || rec.label || ' (' || to_char(rec.dt, 'YYYY-MM-DD') || ')';
      FOREACH lvl IN ARRAY ARRAY['entry', 'review', 'approve'] LOOP
        cell := public.reg_cell_row(rec.register_key, rec.region_id, lvl);
        IF cell IS NULL THEN CONTINUE; END IF;
        FOR u IN SELECT DISTINCT e.user_id FROM public.reg_eligible_cell(cell, rec.region_id, public.reg_module(rec.register_key), 'entry') e LOOP
          INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
          SELECT u.user_id, 'in_app', 'expiry_radar', v_title,
                 days_left::text || ' day(s) left (' || (reg.v ->> 'field') || ' ' || to_char(rec.dt, 'YYYY-MM-DD') || '). Open the record to renew or update it.',
                 '/registers/' || rec.register_key || '/records/' || rec.id::text
          WHERE NOT EXISTS (SELECT 1 FROM public.notifications nt WHERE nt.user_id = u.user_id AND nt.kind = 'expiry_radar' AND nt.title = v_title);
          GET DIAGNOSTICS rows_n = ROW_COUNT;
          n := n + rows_n;
        END LOOP;
      END LOOP;
    END LOOP;
  END LOOP;
  RETURN n;
END $$;

GRANT SELECT ON settings, register_records, matrix_cells, matrix_cell_assignees TO pmis_definer;
GRANT SELECT, INSERT ON notifications TO pmis_definer;

DO $$
BEGIN
  ALTER FUNCTION expiry_radar_notify(date) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION expiry_radar_notify(date) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION expiry_radar_notify(date) TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION expiry_radar_notify(date) TO pmis_app;
  END IF;
END $$;
