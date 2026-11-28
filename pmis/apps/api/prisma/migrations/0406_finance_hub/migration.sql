-- 0406_finance_hub: the Finance hub (owner decision D57, 2026-11-27). Read-only summary page over the two separate registers
--  financial_advances and invoices: one screen with summary cards under the existing register visibility, quick links and the register
--  templates. One addition, additive:
--   the section "finance_hub" of the guarded ui.features setting (Settings > Screens > Finance hub): which widgets of the hub page show,
--   after how many days a disbursed, unsettled advance warns, and the two aging bounds of the open-invoice buckets. A stored value
--   without the section takes the seed. Only ui_features_seed() and ui_features_validate() are patched in place (idempotent); no table, no permission
--   change, nothing public. The page itself reads the registers with the same visibility their screens use; advance amounts follow
--   fin_amounts_visible() (amounts are only counted for the caller that rule already shows them to).
-- Mirror: db/sql/405_finance_hub.sql (kept byte-identical).

SELECT set_config('app.region_ids', '*', true);

-- Both functions are patched in place and idempotently (never a whole redefinition), so sections added by other migrations stay.
DO $$
DECLARE src text; blk text := $blk$
  s := p_sections -> 'finance_hub';
  IF s IS NOT NULL THEN
    IF jsonb_typeof(s) <> 'object' THEN
      errs := errs || public.reg_err_item('/sections/finance_hub', 'invalid', 'An object.');
    ELSE
      FOR kk IN SELECT jsonb_object_keys(s) LOOP
        IF kk NOT IN ('widgets', 'settle_warn_days', 'aging_days') THEN errs := errs || public.reg_err_item('/sections/finance_hub/' || kk, 'unknown_key', 'Unknown key.'); END IF;
      END LOOP;
      w := s -> 'widgets';
      IF w IS NOT NULL THEN
        IF jsonb_typeof(w) <> 'object' THEN
          errs := errs || public.reg_err_item('/sections/finance_hub/widgets', 'invalid', 'An object.');
        ELSE
          FOR kk IN SELECT jsonb_object_keys(w) LOOP
            IF kk NOT IN ('advances', 'invoices', 'quick_links', 'templates') THEN errs := errs || public.reg_err_item('/sections/finance_hub/widgets/' || kk, 'unknown_key', 'Unknown widget.');
            ELSIF jsonb_typeof(w -> kk) IS DISTINCT FROM 'boolean' THEN errs := errs || public.reg_err_item('/sections/finance_hub/widgets/' || kk, 'invalid', 'true or false.'); END IF;
          END LOOP;
        END IF;
      END IF;
      IF s ? 'settle_warn_days' THEN
        IF jsonb_typeof(s -> 'settle_warn_days') IS DISTINCT FROM 'number' OR (s ->> 'settle_warn_days') !~ '^[0-9]+$' THEN
          errs := errs || public.reg_err_item('/sections/finance_hub/settle_warn_days', 'invalid', 'A whole number of days from 1 to 365.');
        ELSE
          n := (s ->> 'settle_warn_days')::integer;
          IF n < 1 OR n > 365 THEN errs := errs || public.reg_err_item('/sections/finance_hub/settle_warn_days', 'out_of_range', 'From 1 to 365 days.'); END IF;
        END IF;
      END IF;
      v := s -> 'aging_days';
      IF v IS NOT NULL THEN
        IF jsonb_typeof(v) IS DISTINCT FROM 'array' OR jsonb_array_length(v) <> 2 THEN
          errs := errs || public.reg_err_item('/sections/finance_hub/aging_days', 'invalid', 'Two day bounds, like [30, 60].');
        ELSE
          FOR el IN SELECT jsonb_array_elements(v) LOOP
            IF jsonb_typeof(el) IS DISTINCT FROM 'number' OR el::text !~ '^[0-9]+$' OR (el::text)::integer < 1 OR (el::text)::integer > 365 THEN
              errs := errs || public.reg_err_item('/sections/finance_hub/aging_days', 'invalid', 'Whole numbers of days from 1 to 365.');
            END IF;
          END LOOP;
          IF (v ->> 0)::integer >= (v ->> 1)::integer THEN
            errs := errs || public.reg_err_item('/sections/finance_hub/aging_days', 'invalid', 'The first bound must be smaller than the second.');
          END IF;
        END IF;
      END IF;
    END IF;
  END IF;
$blk$;
BEGIN
  src := pg_get_functiondef('public.ui_features_seed()'::regprocedure);
  IF position('finance_hub' IN src) = 0 THEN
    IF src !~ '\}''::jsonb\s' THEN RAISE EXCEPTION 'ui_features_seed() has no JSON text to patch'; END IF;
    EXECUTE regexp_replace(src, '\}''::jsonb(\s)', ', "finance_hub": {"widgets": {"advances": true, "invoices": true, "quick_links": true, "templates": true}, "settle_warn_days": 30, "aging_days": [30, 60]}}''::jsonb\1');
  END IF;
  src := pg_get_functiondef('public.ui_features_validate(jsonb)'::regprocedure);
  IF position('finance_hub' IN src) = 0 THEN
    IF position(E'\n  RETURN errs;' IN src) = 0 OR src !~ '''data_hub''(, ''[a-z_]+'')*\)' THEN RAISE EXCEPTION 'ui_features_validate() has no spot to patch'; END IF;
    src := regexp_replace(src, '''data_hub''((, ''[a-z_]+'')*)\)', '''data_hub''\1, ''finance_hub'')');
    EXECUTE replace(src, E'\n  RETURN errs;', E'\n' || blk || '  RETURN errs;');
  END IF;
END $$;

-- The advances card of the hub. fin_amounts_visible() and fin_balance() are definer-only helpers (pmis_app cannot call them), so the card is one definer
-- function. The region scope is read inside from the caller's own financial_advances view right (never passed in); the amount rule is the register's own.
CREATE OR REPLACE FUNCTION finance_hub_advances(p_warn_days integer, OUT open_count bigint, OUT overdue_count bigint, OUT open_amount numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE regs integer[];
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'finance hub: sign in first' USING ERRCODE = 'insufficient_privilege'; END IF;
  regs := public.wf_actor_regions('financial_advances', 'view');
  IF regs IS NOT NULL AND cardinality(regs) = 0 THEN open_count := 0; overdue_count := 0; open_amount := NULL; RETURN; END IF;
  SELECT count(*) FILTER (WHERE coalesce(r.data ->> 'advance_state', '') NOT IN ('settled', 'closed', 'cancelled')),
         count(*) FILTER (WHERE r.data ->> 'advance_state' IN ('disbursed', 'settlement_in_progress')
                          AND nullif(r.data ->> 'disbursed_date', '')::date < public.cal_today() - p_warn_days),
         sum(public.fin_balance(r.entity_id)) FILTER (WHERE coalesce(r.data ->> 'advance_state', '') NOT IN ('settled', 'closed', 'cancelled')
                                                      AND public.fin_amounts_visible(r.id, 'advance', r.data))
    INTO open_count, overdue_count, open_amount
  FROM public.register_records r
  WHERE r.register_key = 'financial_advances' AND r.record_type = 'advance' AND (regs IS NULL OR r.is_global OR r.region_id = ANY(regs))
    AND NOT EXISTS (SELECT 1 FROM public.register_records n WHERE n.entity_id = r.entity_id AND n.version_no > r.version_no);
END $$;

-- The menu key of the Finance hub heading (a saved menu layout is refused for a key the catalogue does not list). Additive; an existing key is kept.
INSERT INTO nav_item_catalogue (key, default_group, ord, added_in) VALUES
  ('finance_hub', 'registers', 265, '0406')
ON CONFLICT (key) DO NOTHING;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('finance_hub_applied', 'workflow', NULL,
        jsonb_build_object('ui_features', 'section finance_hub added to ui.features'),
        'Finance hub setting section and menu key (migration 0406, contract 0.15.361).');

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['ui_features_seed()', 'ui_features_validate(jsonb)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  ALTER FUNCTION finance_hub_advances(integer) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION finance_hub_advances(integer) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION finance_hub_advances(integer) TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN GRANT EXECUTE ON FUNCTION finance_hub_advances(integer) TO pmis_app; END IF;
END $$;
