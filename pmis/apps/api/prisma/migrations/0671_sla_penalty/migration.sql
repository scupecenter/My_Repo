-- SLA penalty calculator (0.15.591): the contractor performance view also computes a penalty from the days a contractor is late, times a daily rate.
-- The rates are one more part of the existing guarded setting `contractors.performance` (key `penalty`: {rate_per_day, currency, cap, overrides}); no
-- new table, no new endpoint, no permission change. Nothing is stored or typed per contractor-day: the API computes it on read from the late days
-- of the contractor's snags (past the target date, or closed after it) and the delay days of its issues. A missing `penalty` key means no rate, so
-- no penalty is shown. admin_set_contractor_perf_thresholds is changed in place and idempotently (anchors that do not depend on indentation): it
-- accepts the optional `penalty` object and validates it (a rate from 0 to 10,000,000 with at most 2 decimals, a three-letter upper case currency,
-- a cap that is null or from 0 to 1,000,000,000, at most 200 overrides keyed by contractor id). An older client that sends the five old keys keeps
-- working and keeps no penalty.

DO $mig$
DECLARE def text;
  a0 text := 'DECLARE cur jsonb;';
  a1 text := '''quality_fail_pct'', ''contract_expiry_days'') THEN';
  a2 text := 'INSERT INTO public.settings (key, value, description, updated_at)';
  blk text := $blk$
  IF p_thresholds ? 'penalty' THEN
    v := p_thresholds -> 'penalty';
    IF jsonb_typeof(v) IS DISTINCT FROM 'object' THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/thresholds/penalty', 'invalid', 'An object.')));
    END IF;
    FOR pk IN SELECT jsonb_object_keys(v) LOOP
      IF pk NOT IN ('rate_per_day', 'currency', 'cap', 'overrides') THEN
        PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/thresholds/penalty/' || left(pk, 40), 'unknown_key', 'Unknown key.')));
      END IF;
    END LOOP;
    IF jsonb_typeof(v -> 'rate_per_day') IS DISTINCT FROM 'number' OR (v ->> 'rate_per_day') !~ '^[0-9]{1,8}(\.[0-9]{1,2})?$' OR (v ->> 'rate_per_day')::numeric > 10000000 THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/thresholds/penalty/rate_per_day', 'out_of_range', 'A rate from 0 to 10,000,000 with at most 2 decimals.')));
    END IF;
    IF jsonb_typeof(v -> 'currency') IS DISTINCT FROM 'string' OR (v ->> 'currency') !~ '^[A-Z]{3}$' THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/thresholds/penalty/currency', 'invalid', 'A three-letter upper case currency code.')));
    END IF;
    IF v ? 'cap' AND jsonb_typeof(v -> 'cap') <> 'null' AND (jsonb_typeof(v -> 'cap') <> 'number' OR (v ->> 'cap') !~ '^[0-9]{1,10}(\.[0-9]{1,2})?$' OR (v ->> 'cap')::numeric > 1000000000) THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/thresholds/penalty/cap', 'out_of_range', 'Null, or an amount from 0 to 1,000,000,000.')));
    END IF;
    pen := jsonb_build_object('rate_per_day', (v ->> 'rate_per_day')::numeric, 'currency', v ->> 'currency',
                              'cap', CASE WHEN jsonb_typeof(v -> 'cap') = 'number' THEN to_jsonb((v ->> 'cap')::numeric) ELSE 'null'::jsonb END, 'overrides', '{}'::jsonb);
    IF v ? 'overrides' THEN
      IF jsonb_typeof(v -> 'overrides') <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(v -> 'overrides')) > 200 THEN
        PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/thresholds/penalty/overrides', 'invalid', 'An object of at most 200 contractors.')));
      END IF;
      FOR pk IN SELECT jsonb_object_keys(v -> 'overrides') LOOP
        IF pk !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR jsonb_typeof(v -> 'overrides' -> pk) <> 'number'
           OR ((v -> 'overrides') ->> pk) !~ '^[0-9]{1,8}(\.[0-9]{1,2})?$' OR ((v -> 'overrides') ->> pk)::numeric > 10000000 THEN
          PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/thresholds/penalty/overrides', 'invalid', 'A contractor id and a rate from 0 to 10,000,000.')));
        END IF;
        pen := jsonb_set(pen, ARRAY['overrides', pk], to_jsonb(((v -> 'overrides') ->> pk)::numeric));
      END LOOP;
    END IF;
    clean := clean || jsonb_build_object('penalty', pen);
  END IF;
  $blk$;
BEGIN
  def := pg_get_functiondef('public.admin_set_contractor_perf_thresholds(jsonb,text,integer)'::regprocedure);
  IF position('''penalty''' IN def) = 0 THEN
    IF position(a0 IN def) = 0 OR position(a1 IN def) = 0 OR position(a2 IN def) = 0 THEN RAISE EXCEPTION 'admin_set_contractor_perf_thresholds: the anchors (0180) were not found'; END IF;
    def := replace(def, a0, 'DECLARE pen jsonb; pk text; cur jsonb;');
    def := replace(def, a1, '''quality_fail_pct'', ''contract_expiry_days'', ''penalty'') THEN');
    def := replace(def, a2, blk || a2);
    EXECUTE def;
  END IF;
END $mig$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('sla_penalty_applied', 'workflow', NULL,
        jsonb_build_object('setting', 'contractors.performance', 'key', 'penalty'),
        'SLA penalty calculator: the daily rate is part of the contractor performance setting (migration 0671, contract 0.15.591).');
