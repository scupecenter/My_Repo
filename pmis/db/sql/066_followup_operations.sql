-- 0067_followup_operations: follow-up group B of the technical decisions of 2026-11-04 (docs/spec/technical-decisions-2026-11-04.md), Q245, Q253, Q257, Q270,
-- Q281 (Q250 is documentation only: tools/install/README.md). Mirror: db/sql/066_followup_operations.sql (kept identical). CHANGELOG 95.
--
-- What it builds
--   1. Q245. The setting calendar.official_confirmed resets to false when the year changes (1 January, Africa/Tripoli): cal_official_confirmed_reset() is
--      called by the daily job (job `calendar_year_reset`, its own job_runs row) and writes an audit row. A confirmation made in an earlier year is reset by
--      the first run of the new year, so a missed night is caught up and a confirmation made after the reset stays.
--   2. Q253. mail.retention_days defaults to 30 (was 90): changed only where the row still holds 90 and no person ever saved it; mail_purge() reads 30 when
--      the setting is missing.
--   3. Q257. log_integrity_finish() also queues a mandatory system mail with the chain head hash to every System Admin (the P9 outbox).
--   4. Q270. Quarantine exits: three movements out of the quarantine, each a Warehouse document with a reason, approved by L2 like any warehouse document:
--      repaired (quarantine to available; ADJ), written_off (quarantine to gone; ADJ), returned_to_supplier (quarantine to out; DN to the vendor, record
--      type sup_dn). wh_movements.kind = 'quarantine_exit' with wh_movements.exit_kind; the stock reads them (quarantine is reduced when the document posts,
--      the pending quantity is reserved in quarantine_pending, only repaired adds to on_hand); serials leave the status Returned.
--   5. Q281 is an API change (the dispatch list leaves out Cancelled sites); nothing in this file.
--   6. Ownership and rights: SECURITY DEFINER with search_path, owner pmis_definer, PUBLIC revoked; pmis_app only calls the two entry points.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Q253: mail retention 30 days
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE n integer;
BEGIN
  UPDATE settings SET value = '30'::jsonb, updated_at = now(),
    description = 'Days a sent, given-up or suppressed mail is kept in the outbox before it is purged (default 30, Q253: long enough to resend a failed mail, less personal data kept).'
  WHERE key = 'mail.retention_days' AND value = '90'::jsonb AND updated_by IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    INSERT INTO audit_log (action, entity_type, entity_id, before, after, reason)
    VALUES ('setting_default_changed', 'setting', 'mail.retention_days', jsonb_build_object('value', 90), jsonb_build_object('value', 30),
            'Technical decision Q253 (2026-11-04), migration 0067: the default of the mail retention is 30 days; a value set by a person is kept.');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION mail_purge() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE days int := greatest(coalesce((public.log_setting('mail.retention_days', '30'::jsonb) #>> '{}')::int, 30), 7); n bigint;
BEGIN
  PERFORM set_config('pmis.log_purge', 'mail_outbox', true);
  DELETE FROM public.mail_outbox WHERE status IN ('sent', 'dead', 'logged', 'suppressed') AND created_at < now() - make_interval(days => days);
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('pmis.log_purge', '', true);
  RETURN n;
END $$;


-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Q245: the official calendar must be confirmed again every year
-- ---------------------------------------------------------------------------------------------------------------------
-- An audit row from a background job. A signed-in person goes through log_audit_write; the job has no person, so the row is written here with no actor:
-- the context of the job (via = job, job_name) is copied into it by the audit trigger. Not callable by pmis_app.
CREATE OR REPLACE FUNCTION followup_audit(p_action text, p_entity_type text, p_entity_id text, p_before jsonb, p_after jsonb, p_reason text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE nid bigint;
BEGIN
  IF public.app_actor() IS NOT NULL THEN
    RETURN public.log_audit_write(p_action, p_entity_type, p_entity_id, p_before, p_after, p_reason);
  END IF;
  IF p_action IS NULL OR p_action !~ '^[a-z][a-z0-9_.]{1,79}$' OR p_entity_type IS NULL OR p_entity_type !~ '^[a-z][a-z0-9_]{1,59}$' THEN
    RAISE EXCEPTION 'audit: action and entity type are lower-case codes' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason)
  VALUES (p_action, p_entity_type, left(p_entity_id, 200), p_before, p_after, left(p_reason, 2000)) RETURNING audit_log.id INTO nid;
  RETURN nid;
END $$;

-- Resets calendar.official_confirmed to false when it was confirmed in an earlier year than today (the calendar's time zone, calc.timezone, Africa/Tripoli
-- by default). Run by the daily job only (it refuses a signed-in person). Returns 1 when it reset, else 0. Idempotent.
CREATE OR REPLACE FUNCTION cal_official_confirmed_reset() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.settings%ROWTYPE; tz text; today date := public.cal_today(); set_day date;
BEGIN
  IF public.app_actor() IS NOT NULL THEN RAISE EXCEPTION 'calendar: the daily job only' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'calendar.official_confirmed' FOR UPDATE;
  IF NOT FOUND OR jsonb_typeof(s.value) <> 'boolean' OR NOT (s.value #>> '{}')::boolean THEN RETURN 0; END IF;
  tz := coalesce(public.calc_setting('calc.timezone', '"Africa/Tripoli"'::jsonb) #>> '{}', 'Africa/Tripoli');
  set_day := (s.updated_at AT TIME ZONE tz)::date;
  IF extract(year FROM set_day) >= extract(year FROM today) THEN RETURN 0; END IF;
  UPDATE public.settings SET value = 'false'::jsonb, updated_at = now(), updated_by = NULL WHERE key = 'calendar.official_confirmed';
  PERFORM public.followup_audit('calendar_official_confirmed_reset', 'setting', 'calendar.official_confirmed',
    jsonb_build_object('value', true, 'confirmed_on', set_day), jsonb_build_object('value', false, 'reset_on', today),
    'A new year began: the official holiday calendar must be confirmed again for the new year (Q245).');
  RETURN 1;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Q257: every finished integrity check mails its head hash to the System Admins
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION log_integrity_finish(p_run uuid, p_anchor jsonb DEFAULT NULL) RETURNS log_integrity_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.log_integrity_runs%ROWTYPE; u record; nb jsonb; ac jsonb; aseq bigint; ahash text; found_hash text; h public.log_chain_heads%ROWTYPE; st text; extra int := 0;
BEGIN
  SELECT * INTO r FROM public.log_integrity_runs WHERE id = p_run FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The integrity check does not exist.')); END IF;
  IF NOT public.log_integrity_driver_ok(r) THEN RAISE EXCEPTION 'log integrity: not the driver of this check' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF r.status <> 'running' THEN RETURN r; END IF;
  IF r.checked_through < r.to_seq THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The check has not reached the end of its range.')); END IF;
  nb := r.breaks;
  FOR u IN
    SELECT a.id FROM public.audit_log a WHERE r.log = 'audit' AND NOT EXISTS (SELECT 1 FROM public.audit_log_chain x WHERE x.audit_id = a.id)
    UNION ALL
    SELECT s.id FROM public.security_log s WHERE r.log = 'security' AND NOT EXISTS (SELECT 1 FROM public.security_log_chain x WHERE x.security_id = s.id)
    ORDER BY 1 LIMIT 100
  LOOP
    extra := extra + 1;
    IF jsonb_array_length(nb) < 100 THEN nb := nb || jsonb_build_object('seq', NULL, 'kind', 'unsealed', 'row_id', u.id, 'expected_hash', NULL, 'found_hash', NULL); END IF;
  END LOOP;
  IF p_anchor IS NOT NULL AND jsonb_typeof(p_anchor) = 'object' AND p_anchor ? 'seq' THEN
    aseq := public.log_num(p_anchor, 'seq');
    ahash := p_anchor ->> 'hash';
    SELECT * INTO h FROM public.log_chain_heads WHERE log = r.log;
    IF aseq IS NOT NULL AND aseq > h.purged_through THEN
      IF r.log = 'audit' THEN SELECT x.hash INTO found_hash FROM public.audit_log_chain x WHERE x.seq = aseq;
      ELSE SELECT x.hash INTO found_hash FROM public.security_log_chain x WHERE x.seq = aseq; END IF;
      ac := jsonb_build_object('seq', aseq, 'ref', left(p_anchor ->> 'ref', 200), 'ok', found_hash IS NOT NULL AND found_hash = ahash);
      IF found_hash IS DISTINCT FROM ahash THEN
        extra := extra + 1;
        IF jsonb_array_length(nb) < 100 THEN
          nb := nb || jsonb_build_object('seq', aseq, 'kind', 'anchor_mismatch', 'row_id', NULL, 'expected_hash', ahash, 'found_hash', found_hash);
        END IF;
      END IF;
    ELSE
      ac := jsonb_build_object('seq', aseq, 'ref', left(p_anchor ->> 'ref', 200), 'ok', NULL, 'note', 'purged or not given');
    END IF;
  END IF;
  st := CASE WHEN r.break_count + extra = 0 THEN 'ok' ELSE 'broken' END;
  UPDATE public.log_integrity_runs SET status = st, finished_at = clock_timestamp(), breaks = nb, break_count = r.break_count + extra, anchor_check = ac
  WHERE id = p_run RETURNING * INTO r;
  PERFORM public.job_run_finish(r.job_run_id, CASE WHEN st = 'ok' THEN 'ok' ELSE 'failed' END, r.row_count, CASE WHEN st = 'broken' THEN r.break_count::text || ' break(s)' END,
    jsonb_build_object('run_id', r.id, 'log', r.log, 'trigger', r.trigger, 'status', st, 'from_seq', r.from_seq, 'to_seq', r.to_seq, 'break_count', r.break_count,
      'head_hash', r.head_hash, 'progress', 100, 'anchor_ok', ac -> 'ok'));
  PERFORM public.log_system_write(CASE WHEN st = 'ok' THEN 'info' ELSE 'error' END, 'integrity', 'log integrity check ' || st,
    jsonb_build_object('run_id', r.id, 'log', r.log, 'trigger', r.trigger, 'row_count', r.row_count, 'from_seq', r.from_seq, 'to_seq', r.to_seq,
      'head_hash', r.head_hash, 'break_count', r.break_count, 'anchor', ac), r.requested_by, NULL);
  IF r.trigger = 'manual' THEN
    PERFORM public.log_audit_write(CASE r.log WHEN 'audit' THEN 'audit_log.integrity_check' ELSE 'security_log.integrity_check' END,
      CASE r.log WHEN 'audit' THEN 'audit_log' ELSE 'security_log' END, r.id::text, NULL,
      jsonb_build_object('status', st, 'row_count', r.row_count, 'first_seq', r.from_seq, 'last_seq', r.to_seq, 'head_hash', r.head_hash, 'break_count', r.break_count,
        'run_id', r.id, 'as_job', true), NULL);
  END IF;
  IF st = 'broken' THEN
    PERFORM public.sec_alert_raise('audit_integrity_failure', 'critical', 'Log integrity check found a break',
      jsonb_build_object('log', r.log, 'breaks', nb -> 0, 'break_count', r.break_count, 'run_id', r.id, 'trigger', r.trigger),
      'audit_integrity_failure:' || r.log || ':run:' || r.id::text, NULL, NULL);
  END IF;
  -- Q257: the head hash goes to the System Admins by mail as well, so the anchor exists in two places the database cannot rewrite (the anchor file
  -- off the server, and the mailboxes). A mandatory system mail: never capped; a failure to queue never breaks the check.
  BEGIN
    PERFORM public.mail_to_system_admins('integrity_head',
      left('[PMIS] ' || CASE r.log WHEN 'audit' THEN 'Audit Log' ELSE 'Security log' END || ' integrity check ' || st || ': head ' || left(coalesce(r.head_hash, 'none'), 12), 200),
      'A log integrity check finished in GSDN PMIS. Keep this mail: the head hash is an anchor kept outside the database.' || E'\n'
      || 'اكتمل فحص سلامة السجل في GSDN PMIS. احتفظ بهذه الرسالة: بصمة الرأس مرجع محفوظ خارج قاعدة البيانات.' || E'\n\n'
      || 'Log: ' || r.log || E'\n' || 'Result: ' || st || E'\n' || 'Checked positions: ' || r.from_seq::text || ' to ' || r.to_seq::text || E'\n'
      || 'Head hash (SHA-256): ' || coalesce(nullif(btrim(r.head_hash), ''), 'none (empty chain)') || E'\n' || 'Run: ' || r.id::text || ' (' || r.trigger || ')' || E'\n'
      || 'Finished at: ' || public.log_ts_text(r.finished_at) || ' (UTC)' || E'\n\n'
      || 'To check: the same hash is the last line of the anchor file anchor-' || r.log || '.jsonl in LOG_ANCHOR_DIR on the server, and in the nightly file backup.',
      'integrity_head:' || r.id::text,
      jsonb_build_object('run_id', r.id, 'log', r.log, 'status', st, 'mandatory', true));
  EXCEPTION WHEN others THEN
    PERFORM public.log_system_write('error', 'mail', 'integrity head mail not queued', jsonb_build_object('run_id', r.id, 'error', left(SQLERRM, 200)), NULL, NULL);
  END;
  RETURN r;
END $$;


-- The kind integrity_head is reserved for the database, like security_alert: nobody signed in can send a forged anchor mail to the System Admins.
CREATE OR REPLACE FUNCTION mail_send_to_user(p_kind text, p_user uuid, p_subject text, p_body text, p_dedup text DEFAULT NULL, p_sensitive boolean DEFAULT false)
  RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE e text;
BEGIN
  IF p_kind LIKE 'security_alert%' OR p_kind LIKE 'integrity_head%' THEN RAISE EXCEPTION 'mail: kind % is reserved', p_kind USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT u.email INTO e FROM public.users u WHERE u.id = p_user AND u.status = 'active' AND u.deleted_at IS NULL;
  IF e IS NULL OR NOT public.mail_address_ok(e) THEN RETURN NULL; END IF;
  RETURN public.mail_enqueue_internal(p_kind, e, p_user, p_subject, p_body, p_dedup, p_sensitive, jsonb_build_object('via', 'api'));
END $$;


CREATE OR REPLACE FUNCTION mail_send_to_address(p_kind text, p_to text, p_subject text, p_body text, p_dedup text DEFAULT NULL, p_sensitive boolean DEFAULT false)
  RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor();
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'mail: no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_kind LIKE 'security_alert%' OR p_kind LIKE 'integrity_head%' THEN RAISE EXCEPTION 'mail: kind % is reserved', p_kind USING ERRCODE = 'insufficient_privilege'; END IF;
  -- one person cannot use the server to mail arbitrary addresses in bulk
  IF (SELECT count(*) FROM public.mail_outbox m WHERE m.created_by = a AND m.to_user_id IS NULL AND m.created_at > now() - interval '1 hour') >= 20 THEN
    RAISE EXCEPTION 'mail: too many mails to addresses this hour' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN public.mail_enqueue_internal(p_kind, p_to, (SELECT u.id FROM public.users u WHERE u.email = lower(trim(p_to)) LIMIT 1), p_subject, p_body, p_dedup, p_sensitive,
    jsonb_build_object('via', 'api'));
END $$;


-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Q270: quarantine exits
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE wh_movements ADD COLUMN exit_kind TEXT CHECK (exit_kind IN ('repaired', 'written_off', 'returned_to_supplier'));
COMMENT ON COLUMN wh_movements.exit_kind IS 'Q270: set on (and only on) a quarantine_exit: repaired = quarantine to available (ADJ), written_off = quarantine to gone (ADJ), returned_to_supplier = quarantine to out (DN to the vendor, sup_dn).';
ALTER TABLE wh_movements DROP CONSTRAINT wh_movements_record_type_check;
ALTER TABLE wh_movements ADD CONSTRAINT wh_movements_record_type_check CHECK (record_type IN ('te_dn', 'cw_dn', 'te_rn', 'cw_rn', 'pl', 'open', 'adj', 'sup_dn'));
ALTER TABLE wh_movements DROP CONSTRAINT wh_movements_kind_check;
ALTER TABLE wh_movements ADD CONSTRAINT wh_movements_kind_check CHECK (kind IN ('issue', 'return', 'receipt', 'adjustment', 'quarantine_exit'));
ALTER TABLE wh_movements ADD CONSTRAINT wh_movements_exit_shape CHECK (
  (kind = 'quarantine_exit') = (exit_kind IS NOT NULL)
  AND (exit_kind IS NULL OR (is_global AND site_id IS NULL AND record_type = CASE exit_kind WHEN 'returned_to_supplier' THEN 'sup_dn' ELSE 'adj' END)));

-- the Warehouse register: the new document type (no site, like ADJ) and the two header fields
UPDATE register_definitions SET record_types = record_types || ARRAY['sup_dn'], site_optional_types = site_optional_types || ARRAY['sup_dn']
WHERE register_key = 'warehouse' AND NOT ('sup_dn' = ANY (record_types));
INSERT INTO register_fields (register_key, code, label_en, label_ar, field_type, required, is_actual, derived, options, in_list, section, sort_order) VALUES
  ('warehouse', 'exit_kind',   'Quarantine exit',        'خروج من الحجر',        'text', false, false, false, NULL, true,  'Quarantine exit', 70),
  ('warehouse', 'exit_reason', 'Quarantine exit reason', 'سبب الخروج من الحجر', 'text', false, false, false, NULL, false, 'Quarantine exit', 80)
ON CONFLICT (register_key, code) DO NOTHING;

-- numbering of the DN to the supplier: global like ADJ-WH (the pattern is the admin's to change)
ALTER TABLE doc_sequences DROP CONSTRAINT doc_sequences_record_type_check;
ALTER TABLE doc_sequences ADD CONSTRAINT doc_sequences_record_type_check CHECK (record_type IN ('te_dn', 'cw_dn', 'te_rn', 'cw_rn', 'pl', 'open', 'adj', 'sup_dn'));
ALTER TABLE doc_sequences DROP CONSTRAINT doc_sequences_site_types;
ALTER TABLE doc_sequences ADD CONSTRAINT doc_sequences_site_types CHECK (record_type IS NULL OR (record_type IN ('pl', 'open', 'adj', 'sup_dn')) = (region_id IS NULL));
INSERT INTO doc_sequences (key, form_kind, record_type, region_id, region_code, pattern, reset) VALUES
  ('DN-SUP-WH', NULL, 'sup_dn', NULL, NULL, 'DN-SUP-WH-{YYYY}-{SEQ:4}', 'yearly')
ON CONFLICT (key) DO NOTHING;

-- Stock with quarantine (0053) and its exits. Central stock (p_site NULL): a posted quarantine exit takes its quantity out of the quarantine; a repaired one
-- adds it to on_hand (and so to available), a written-off one and a one returned to the supplier leave the stock. A pending exit holds its quantity in
-- quarantine_pending, so it cannot be taken twice. Per site: unchanged (the exits have no site).
DROP FUNCTION wh_stock_levels(uuid, uuid);
CREATE FUNCTION wh_stock_levels(p_item uuid DEFAULT NULL, p_site uuid DEFAULT NULL)
RETURNS TABLE (item_id uuid, on_hand numeric, reserved numeric, pending_issue numeric, pending_return numeric, available numeric, quarantine numeric, quarantine_pending numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH l AS (
    SELECT li.item_id AS iid, li.qty, m.kind, m.status, m.exit_kind, (m.kind = 'return' AND li.condition IN ('Faulty', 'Damaged')) AS quar
    FROM public.wh_movement_lines li JOIN public.wh_movements m ON m.id = li.movement_id
    WHERE m.status <> 'cancelled' AND (p_item IS NULL OR li.item_id = p_item)
      AND (p_site IS NULL OR (m.site_id = p_site AND m.kind IN ('issue', 'return')))
  ), s AS (
    SELECT l.iid,
      sum(CASE WHEN l.status = 'posted' THEN
                 CASE WHEN p_site IS NULL THEN CASE WHEN l.kind = 'issue' THEN -l.qty
                                                    WHEN l.kind = 'quarantine_exit' THEN CASE WHEN l.exit_kind = 'repaired' THEN l.qty ELSE 0 END
                                                    WHEN l.quar THEN 0 ELSE l.qty END
                      ELSE CASE l.kind WHEN 'issue' THEN l.qty ELSE -l.qty END END
               ELSE 0 END) AS oh,
      sum(CASE WHEN l.status = 'pending' AND p_site IS NULL AND (l.kind = 'issue' OR (l.kind = 'adjustment' AND l.qty < 0)) THEN abs(l.qty) ELSE 0 END) AS rs,
      sum(CASE WHEN l.status = 'pending' AND l.kind = 'issue' THEN l.qty ELSE 0 END) AS pi,
      sum(CASE WHEN l.status = 'pending' AND l.kind = 'return' THEN l.qty ELSE 0 END) AS pr,
      sum(CASE WHEN l.status = 'posted' AND p_site IS NULL AND l.quar THEN l.qty
               WHEN l.status = 'posted' AND p_site IS NULL AND l.kind = 'quarantine_exit' THEN -l.qty ELSE 0 END) AS qu,
      sum(CASE WHEN l.status = 'pending' AND p_site IS NULL AND l.kind = 'quarantine_exit' THEN l.qty ELSE 0 END) AS qp
    FROM l GROUP BY l.iid
  )
  SELECT i.id, coalesce(s.oh, 0), coalesce(s.rs, 0), coalesce(s.pi, 0), coalesce(s.pr, 0), coalesce(s.oh, 0) - coalesce(s.rs, 0), coalesce(s.qu, 0), coalesce(s.qp, 0)
  FROM public.warehouse_items i LEFT JOIN s ON s.iid = i.id
  WHERE (p_item IS NULL OR i.id = p_item) AND (p_site IS NULL OR s.iid IS NOT NULL) AND (i.is_active OR s.iid IS NOT NULL)
$$;

-- The movement follows its register record: approved -> posted (stock, serials, site quantity), voided -> cancelled (reservation released). 0067: a
-- quarantine exit moves its serials out of 'Returned' and is audited when it posts.
CREATE OR REPLACE FUNCTION wh_on_state() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE m public.wh_movements%ROWTYPE; ln public.wh_movement_lines%ROWTYPE; doc text := nullif(btrim(NEW.data ->> 'doc_no'), '');
  ddate date := CASE WHEN NEW.data ->> 'doc_date' ~ '^\d{4}-\d{2}-\d{2}$' THEN (NEW.data ->> 'doc_date')::date ELSE public.doc_today() END; cond text;
BEGIN
  SELECT * INTO m FROM public.wh_movements WHERE entity_id = NEW.entity_id FOR UPDATE;
  IF NOT FOUND OR m.status <> 'pending' THEN RETURN NULL; END IF;
  IF NEW.state = 'voided' THEN
    UPDATE public.wh_movements SET status = 'cancelled', cancel_reason = NEW.void_reason, version = version + 1 WHERE id = m.id;
    RETURN NULL;
  END IF;
  FOR ln IN SELECT * FROM public.wh_movement_lines WHERE movement_id = m.id LOOP
    IF m.kind = 'receipt' AND cardinality(ln.serials) > 0 THEN
      INSERT INTO public.warehouse_serials (item_id, serial_no, pl_invoice_no, status, is_global) SELECT ln.item_id, s, doc, 'In Stock', true FROM unnest(ln.serials) s;
    ELSIF m.kind = 'issue' THEN
      UPDATE public.warehouse_serials SET site_id = m.site_id, region_id = m.region_id, is_global = false, dn_no = doc, dispatch_date = ddate, status = 'Dispatched'
        WHERE item_id = ln.item_id AND serial_no = ANY (ln.serials);
    ELSIF m.kind = 'return' THEN
      cond := coalesce(ln.condition, CASE WHEN NEW.data ->> 'condition' IN ('Good', 'Faulty', 'Damaged') THEN NEW.data ->> 'condition' END, 'Good');
      UPDATE public.wh_movement_lines SET condition = cond WHERE id = ln.id AND condition IS DISTINCT FROM cond;
      UPDATE public.warehouse_serials SET rn_no = doc, return_condition = cond, status = CASE WHEN cond = 'Good' THEN 'In Stock' ELSE 'Returned' END,
        site_id = NULL, region_id = NULL, is_global = true WHERE item_id = ln.item_id AND serial_no = ANY (ln.serials);
    ELSIF m.kind = 'quarantine_exit' AND cardinality(ln.serials) > 0 THEN
      -- Q270: the serials leave quarantine ('Returned') for the store, the write-off or the supplier
      UPDATE public.warehouse_serials SET status = CASE m.exit_kind WHEN 'repaired' THEN 'In Stock' WHEN 'written_off' THEN 'Written Off' ELSE 'Returned to Supplier' END
        WHERE item_id = ln.item_id AND serial_no = ANY (ln.serials) AND status = 'Returned';
    END IF;
    IF m.kind IN ('issue', 'return') THEN
      INSERT INTO public.warehouse_site_qty (site_id, region_id, item_id, dispatched) VALUES (m.site_id, m.region_id, ln.item_id, CASE m.kind WHEN 'issue' THEN ln.qty ELSE -ln.qty END)
      ON CONFLICT (site_id, item_id) DO UPDATE SET dispatched = public.warehouse_site_qty.dispatched + EXCLUDED.dispatched;
    END IF;
  END LOOP;
  UPDATE public.wh_movements SET status = 'posted', posted_at = now(), doc_no = doc, doc_date = ddate, version = version + 1 WHERE id = m.id;
  IF m.kind = 'quarantine_exit' THEN
    PERFORM public.log_audit_write('warehouse_quarantine_exit_posted', 'wh_movement', m.id::text, NULL,
      jsonb_build_object('exit_kind', m.exit_kind, 'doc_no', doc, 'doc_date', ddate,
        'lines', (SELECT coalesce(jsonb_agg(jsonb_build_object('item_id', l.item_id, 'qty', l.qty, 'serials', to_jsonb(l.serials)) ORDER BY l.sort_order), '[]'::jsonb)
                  FROM public.wh_movement_lines l WHERE l.movement_id = m.id)),
      nullif(btrim(NEW.data ->> 'exit_reason'), ''));
  END IF;
  RETURN NULL;
END $$;


-- Submit-time rules (0053 text plus Q270): a quarantine exit names its reason and keeps its kind.
CREATE OR REPLACE FUNCTION reg_validate_warehouse(p_record uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; errs jsonb := '[]'::jsonb; other uuid; ln record;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  IF r.register_key <> 'warehouse' THEN RETURN errs; END IF;
  IF r.record_type IS NULL THEN errs := errs || public.reg_err_item('/record_type', 'required', 'The document type is required.'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.wh_movements m JOIN public.wh_movement_lines l ON l.movement_id = m.id WHERE m.entity_id = r.entity_id) THEN
    errs := errs || public.reg_err_item('/lines', 'lines_required', 'A warehouse document needs at least one quantity: create it with POST /warehouse/movements.');
  END IF;
  IF r.record_type IN ('te_rn', 'cw_rn') AND btrim(coalesce(r.data ->> 'reason', '')) = '' THEN errs := errs || public.reg_err_item('/data/reason', 'required', 'A return note needs a reason (BP 10).'); END IF;
  IF r.record_type IN ('te_rn', 'cw_rn') AND r.data ->> 'reason' = 'Faulty or Damaged' AND coalesce(r.data ->> 'condition', '') NOT IN ('Good', 'Faulty', 'Damaged') THEN
    FOR ln IN SELECT l.sort_order FROM public.wh_movements m JOIN public.wh_movement_lines l ON l.movement_id = m.id WHERE m.entity_id = r.entity_id AND l.condition IS NULL ORDER BY l.sort_order LOOP
      errs := errs || public.reg_err_item('/lines/' || (ln.sort_order - 1) || '/condition', 'condition_required', 'A return for Faulty or Damaged names the condition of each line (Q105).');
    END LOOP;
  END IF;
  -- Q270: a quarantine exit names its reason, and its record still says what the movement is (the movement decides, the record is only read)
  IF EXISTS (SELECT 1 FROM public.wh_movements m WHERE m.entity_id = r.entity_id AND m.exit_kind IS NOT NULL) THEN
    IF char_length(btrim(coalesce(r.data ->> 'exit_reason', ''))) < 3 THEN
      errs := errs || public.reg_err_item('/data/exit_reason', 'required', 'A quarantine exit needs a reason (Q270).');
    END IF;
    IF r.data ->> 'exit_kind' IS DISTINCT FROM (SELECT CASE m.exit_kind WHEN 'repaired' THEN 'Repaired back to stock' WHEN 'written_off' THEN 'Written off' ELSE 'Returned to supplier' END
                                                FROM public.wh_movements m WHERE m.entity_id = r.entity_id) THEN
      errs := errs || public.reg_err_item('/data/exit_kind', 'exit_kind_fixed', 'The kind of a quarantine exit cannot be changed: cancel the document and make a new one.');
    END IF;
  END IF;
  SELECT x.id INTO other FROM public.register_records x WHERE x.register_key = 'warehouse' AND x.entity_id <> r.entity_id AND x.state <> 'voided' AND lower(x.data ->> 'doc_no') = lower(r.data ->> 'doc_no') LIMIT 1;
  IF other IS NOT NULL THEN errs := errs || public.reg_err_item('/data/doc_no', 'duplicate', 'Duplicate Doc No.'); END IF;
  RETURN errs;
END $$;


-- Creates a quarantine exit: p_exit repaired | written_off | returned_to_supplier; p_data {exit_reason (required), doc_no, doc_date, txn_status, remark};
-- p_lines [{item_id, qty (> 0), serials}]. The register checks who may create (grant, entry holder). Each line is limited to the quarantined quantity that
-- is not already in another pending exit (422 insufficient_stock); a serial-tracked item names one serial per unit, each in the status Returned and not in
-- another pending exit. The document is numbered like any other (sequence of its type, else typed), then submitted, reviewed and approved through its
-- register record; it posts on the final approval.
CREATE OR REPLACE FUNCTION wh_create_quarantine_exit(p_exit text, p_data jsonb, p_lines jsonb) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  rtype text; rid uuid; rec public.register_records%ROWTYPE; mid uuid; ln jsonb; i int := 0; it public.warehouse_items%ROWTYPE; q numeric; errs jsonb := '[]'::jsonb;
  sers text[]; sn text; st record; ser_row public.warehouse_serials%ROWTYPE; docno text; seen uuid[] := ARRAY[]::uuid[]; iid uuid; seq text; why text; dat jsonb; lbl text; dup uuid;
BEGIN
  IF p_exit IS NULL OR NOT (p_exit = ANY (ARRAY['repaired', 'written_off', 'returned_to_supplier'])) THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/exit_kind', 'not_in_list', 'repaired, written_off or returned_to_supplier.')));
  END IF;
  why := btrim(coalesce(p_data ->> 'exit_reason', ''));
  IF char_length(why) < 3 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/reason', 'required', 'A quarantine exit needs a reason (Q270).')));
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/lines', 'required', 'At least one line is required.')));
  END IF;
  rtype := CASE p_exit WHEN 'returned_to_supplier' THEN 'sup_dn' ELSE 'adj' END;
  lbl := CASE p_exit WHEN 'repaired' THEN 'Repaired back to stock' WHEN 'written_off' THEN 'Written off' ELSE 'Returned to supplier' END;
  -- the header the register requires at submit: the date (today, project time zone) and the document status of a new document are filled when missing
  dat := jsonb_build_object('doc_date', public.doc_today()::text, 'txn_status', 'Approved') || coalesce(p_data, '{}'::jsonb) || jsonb_build_object('exit_kind', lbl, 'exit_reason', why);
  rid := public.reg_save_record('warehouse', NULL, NULL, NULL, rtype, dat, NULL, NULL, false);
  SELECT * INTO rec FROM public.register_records WHERE id = rid;
  docno := btrim(coalesce(rec.data ->> 'doc_no', ''));
  IF docno <> '' THEN
    SELECT x.id INTO dup FROM public.register_records x WHERE x.register_key = 'warehouse' AND x.id <> rid AND x.state <> 'voided' AND lower(x.data ->> 'doc_no') = lower(docno) LIMIT 1;
    IF dup IS NOT NULL OR EXISTS (SELECT 1 FROM public.doc_number_issues x WHERE lower(x.number) = lower(docno)) THEN
      PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'Duplicate Doc No.: ' || docno));
    END IF;
  ELSE
    SELECT k.key INTO seq FROM public.doc_sequences k WHERE k.is_active AND k.record_type = rtype AND k.region_id IS NULL;
    IF seq IS NOT NULL THEN
      docno := public.doc_next_number(seq, CASE WHEN rec.data ->> 'doc_date' ~ '^\d{4}-\d{2}-\d{2}$' THEN (rec.data ->> 'doc_date')::date END, 'wh_movement', rec.entity_id);
      UPDATE public.register_records SET data = data || jsonb_build_object('doc_no', docno) WHERE id = rid;
      PERFORM public.log_audit_write('doc_number_issue', 'register_record', rid::text, NULL, jsonb_build_object('doc_no', docno, 'sequence_key', seq), NULL, NULL, NULL);
    END IF;
  END IF;
  INSERT INTO public.wh_movements (entity_id, record_id, record_type, kind, exit_kind, site_id, region_id, is_global, created_by, sequence_key)
  VALUES (rec.entity_id, rid, rtype, 'quarantine_exit', p_exit, NULL, NULL, true, public.app_actor(), seq) RETURNING id INTO mid;

  -- lock the items in a fixed order: two documents cannot both take the last quarantined unit
  PERFORM 1 FROM public.warehouse_items w WHERE w.id IN (SELECT (e ->> 'item_id')::uuid FROM jsonb_array_elements(p_lines) e WHERE e ->> 'item_id' ~* '^[0-9a-f-]{36}$') ORDER BY w.id FOR UPDATE;

  FOR ln IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    i := i + 1;
    IF coalesce(ln ->> 'item_id', '') !~* '^[0-9a-f-]{36}$' THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/item_id', 'required', 'The item is required.'); CONTINUE; END IF;
    iid := (ln ->> 'item_id')::uuid;
    SELECT * INTO it FROM public.warehouse_items w WHERE w.id = iid AND w.is_active;
    IF NOT FOUND THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/item_id', 'unknown_item', 'Unknown or inactive item.'); CONTINUE; END IF;
    IF iid = ANY (seen) THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/item_id', 'duplicate', 'The item appears twice: use one line per item.'); CONTINUE; END IF;
    seen := seen || iid;
    IF coalesce(ln ->> 'qty', '') !~ '^[0-9]+(\.[0-9]{1,3})?$' OR (ln ->> 'qty')::numeric <= 0 THEN
      errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/qty', 'not_positive', 'The quantity must be a number above zero.'); CONTINUE;
    END IF;
    q := (ln ->> 'qty')::numeric;
    IF lower(coalesce(it.unit, '')) IN ('pcs', 'set') AND q <> trunc(q) THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/qty', 'whole_units', 'No fraction in whole units (pieces and sets).'); CONTINUE; END IF;
    sers := CASE WHEN ln ? 'serials' AND jsonb_typeof(ln -> 'serials') = 'array' THEN ARRAY(SELECT btrim(x) FROM jsonb_array_elements_text(ln -> 'serials') x) ELSE ARRAY[]::text[] END;
    IF cardinality(sers) <> (SELECT count(DISTINCT s) FROM unnest(sers) s) OR '' = ANY (sers) THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'duplicate_serial', 'A serial appears twice or is empty.'); CONTINUE; END IF;
    IF NOT it.serialised AND cardinality(sers) > 0 THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'not_serial_tracked', 'This item is not serial-tracked.'); CONTINUE; END IF;
    IF it.serialised AND cardinality(sers) <> q THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'serial_count', 'The serial count must equal the quantity (' || q || ').'); CONTINUE; END IF;
    FOREACH sn IN ARRAY sers LOOP
      SELECT * INTO ser_row FROM public.warehouse_serials w WHERE w.serial_no = sn;
      IF NOT FOUND OR ser_row.item_id <> iid THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'unknown_serial', 'Unknown serial for this item: ' || sn);
      ELSIF ser_row.status IS DISTINCT FROM 'Returned' THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'serial_not_quarantined', 'The serial is not in quarantine: ' || sn);
      ELSIF EXISTS (SELECT 1 FROM public.wh_movement_lines o JOIN public.wh_movements om ON om.id = o.movement_id WHERE om.status = 'pending' AND om.kind = 'quarantine_exit' AND sn = ANY (o.serials) AND om.id <> mid) THEN
        errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'serial_reserved', 'Serial in another pending quarantine exit: ' || sn);
      END IF;
    END LOOP;
    SELECT * INTO st FROM public.wh_stock_levels(iid, NULL);
    IF st.quarantine - st.quarantine_pending < q THEN
      PERFORM public.wf_err('insufficient_stock', jsonb_build_object('detail', 'Not enough quarantined stock of ' || it.name || ': ' || trim_scale(st.quarantine - st.quarantine_pending) || ' can leave quarantine (' || trim_scale(st.quarantine) || ' in quarantine, ' || trim_scale(st.quarantine_pending) || ' already in pending exits).',
        'errors', public.reg_err_item('/lines/' || (i - 1) || '/qty', 'insufficient_quarantine', 'In quarantine: ' || trim_scale(st.quarantine - st.quarantine_pending))));
    END IF;
    INSERT INTO public.wh_movement_lines (movement_id, item_id, qty, qty_approved, condition, serials, sort_order) VALUES (mid, iid, q, NULL, NULL, sers, i);
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  PERFORM public.log_audit_write('warehouse_quarantine_exit_create', 'wh_movement', mid::text, NULL,
    jsonb_build_object('exit_kind', p_exit, 'record_type', rtype, 'doc_no', docno, 'register_record_id', rid,
      'lines', (SELECT coalesce(jsonb_agg(jsonb_build_object('item_id', l.item_id, 'qty', l.qty, 'serials', to_jsonb(l.serials)) ORDER BY l.sort_order), '[]'::jsonb)
                FROM public.wh_movement_lines l WHERE l.movement_id = mid)),
    why);
  RETURN mid;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Ownership and rights. pmis_app calls only the job entry point and the exit writer; the audit helper and the changed internals have no right for it.
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT, UPDATE ON settings TO pmis_definer;
GRANT INSERT ON audit_log TO pmis_definer;
GRANT USAGE ON SEQUENCE audit_log_id_seq TO pmis_definer;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['followup_audit(text,text,text,jsonb,jsonb,text)', 'cal_official_confirmed_reset()', 'log_integrity_finish(uuid,jsonb)', 'mail_purge()',
    'mail_send_to_user(text,uuid,text,text,text,boolean)', 'mail_send_to_address(text,text,text,text,text,boolean)',
    'wh_stock_levels(uuid,uuid)', 'wh_on_state()', 'reg_validate_warehouse(uuid)', 'wh_create_quarantine_exit(text,jsonb,jsonb)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY['cal_official_confirmed_reset()', 'wh_stock_levels(uuid,uuid)', 'wh_create_quarantine_exit(text,jsonb,jsonb)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
    REVOKE ALL ON FUNCTION followup_audit(text, text, text, jsonb, jsonb, text) FROM pmis_app;
  END IF;
END $$;
