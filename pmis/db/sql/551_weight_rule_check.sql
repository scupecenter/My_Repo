-- 0552: weight_set_errors also checks the measure rule of every item (Settings review gap 1, Ahmed approved 2026-11-27). Patched in place (CREATE OR REPLACE keeps owner
-- and grants). Only a draft that is being published is refused; published sets and frozen snapshots are untouched. Methods: none, tasks, register.

CREATE OR REPLACE FUNCTION weight_set_errors(p_set uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE errs jsonb := '[]'::jsonb; total numeric; r record; idx int := 0; m jsonb; t text; msg text;
BEGIN
  SELECT coalesce(sum(weight), 0) INTO total FROM public.weight_activities WHERE weight_set_id = p_set;
  IF abs(total - 100) > 0.001 THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/activities', 'code', 'weights_must_total_100', 'message', 'The activity weights total ' || trim(trailing '.' from trim(trailing '0' from total::text)) || ', they must total 100.'));
  END IF;
  FOR r IN SELECT a.code, (row_number() OVER (ORDER BY a.sort, a.code)) - 1 AS pos, sum(i.weight) AS s
           FROM public.weight_activities a JOIN public.weight_items i ON i.activity_id = a.id WHERE a.weight_set_id = p_set GROUP BY a.id, a.code, a.sort ORDER BY a.sort, a.code LOOP
    IF abs(r.s - 100) > 0.001 THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/activities/' || r.pos || '/items', 'code', 'weights_must_total_100',
        'message', 'The items of activity ' || r.code || ' total ' || trim(trailing '.' from trim(trailing '0' from r.s::text)) || ', they must total 100.'));
    END IF;
  END LOOP;
  -- 0552 (Settings review, gap 1): the measure rule of every item. A rule the dashboard cannot read, or a task code that is not in any workflow, used to
  -- count nothing without a word; now the draft cannot be published until the rule is sound. Empty (NULL) = not counted automatically.
  FOR r IN SELECT i.code AS icode, i.measure_rule AS mr, (row_number() OVER (ORDER BY a.sort, a.code)) AS apos FROM public.weight_activities a
           JOIN public.weight_items i ON i.activity_id = a.id WHERE a.weight_set_id = p_set ORDER BY a.sort, a.code, i.sort, i.code LOOP
    CONTINUE WHEN r.mr IS NULL;
    msg := NULL;
    IF jsonb_typeof(r.mr) <> 'object' THEN
      msg := 'The measure rule of item ' || r.icode || ' is not a structured rule; choose a method.';
    ELSE
      m := r.mr;
      IF coalesce(m ->> 'method', 'none') NOT IN ('none', 'tasks', 'register') THEN
        msg := 'The measure rule of item ' || r.icode || ' has an unknown method.';
      ELSIF coalesce(m ->> 'method', 'none') = 'tasks' THEN
        IF jsonb_typeof(m -> 'tasks') IS DISTINCT FROM 'array' OR jsonb_array_length(m -> 'tasks') = 0 THEN
          msg := 'Item ' || r.icode || ' counts tasks but names none.';
        ELSE
          FOR t IN SELECT jsonb_array_elements_text(m -> 'tasks') LOOP
            IF NOT EXISTS (SELECT 1 FROM public.task_definitions td WHERE td.code = t) THEN
              msg := 'Item ' || r.icode || ' names the task ' || t || ', which is not in any workflow.'; EXIT;
            END IF;
          END LOOP;
        END IF;
        IF msg IS NULL AND m ? 'plan' AND coalesce(m ->> 'plan', '') !~ '^MS([1-9]|10)$' THEN
          msg := 'Item ' || r.icode || ' has a plan that is not a milestone (MS1 to MS10).';
        END IF;
      ELSIF m ->> 'method' = 'register' AND coalesce(btrim(m ->> 'register'), '') = '' THEN
        msg := 'Item ' || r.icode || ' counts a register but names none.';
      END IF;
      IF msg IS NULL AND m ? 'central' AND jsonb_typeof(m -> 'central') <> 'boolean' THEN
        msg := 'The central flag of item ' || r.icode || ' must be true or false.';
      END IF;
    END IF;
    IF msg IS NOT NULL THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/activities/' || (r.apos - 1) || '/items', 'code', 'measure_rule_invalid', 'message', msg));
    END IF;
  END LOOP;
  RETURN errs;
END $$;
