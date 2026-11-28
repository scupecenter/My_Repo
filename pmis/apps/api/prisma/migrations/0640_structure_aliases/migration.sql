-- 0640: alternative names (import aliases) of a register column. A column keeps its code; its label can change over time and people name the same column in different ways in
-- their own copies of a template. The list of aliases is stored on the column (register_fields.import_aliases), travels with the column everywhere the column is described
-- (the Columns screen JSON, the Structure sheet, the structure proposals and their undo, the audit record) and is read by the data upload: a header that equals the label
-- of the column OR one of its aliases (ignoring case and surrounding spaces) is the column. Nothing else about the upload changes: the order of the columns, the
-- typed values and the version rules (D112) stay as they are.
-- Additive: one column with a default, one helper, and in-place patches (from the stored text, asserted, idempotent) of rcol_json, admin_reg_field_save, structure_diff and
-- admin_structure_proposal_revert. No grant and no permission change.

ALTER TABLE register_fields ADD COLUMN IF NOT EXISTS import_aliases text[] NOT NULL DEFAULT '{}';
COMMENT ON COLUMN register_fields.import_aliases IS '0640: other names of the column that the data upload accepts as its header (sorted, distinct, trimmed, up to 20 of up to 200 characters).';

-- The normal form of an alias list: a JSON array of texts (or NULL) becomes a sorted array of distinct, trimmed, non-empty texts.
CREATE OR REPLACE FUNCTION rcol_aliases(p jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT coalesce(array_agg(DISTINCT t ORDER BY t), ARRAY[]::text[])
  FROM (SELECT btrim(e) AS t FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p) = 'array' THEN p ELSE '[]'::jsonb END) e) s WHERE t <> ''
$$;

-- Patch one function in place: every (old, new) pair must be found exactly once, or its new text must be there already.
CREATE OR REPLACE FUNCTION pg_temp.patch_fn(sig regprocedure, pairs text[]) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE d text := pg_get_functiondef(sig); i int; o text; n text;
BEGIN
  FOR i IN 1 .. array_length(pairs, 1) / 2 LOOP
    o := pairs[2 * i - 1]; n := pairs[2 * i];
    IF position(n IN d) > 0 THEN CONTINUE; END IF;
    IF (length(d) - length(replace(d, o, ''))) / length(o) <> 1 THEN RAISE EXCEPTION '0640: % not found exactly once in %', left(o, 60), sig; END IF;
    d := replace(d, o, n);
  END LOOP;
  EXECUTE d;
END $f$;

SELECT pg_temp.patch_fn('rcol_json(register_fields)'::regprocedure, ARRAY[
  $a$'default_value', f.default_value, 'version', f.version)$a$, $b$'default_value', f.default_value, 'import_aliases', to_jsonb(f.import_aliases), 'version', f.version)$b$]);

SELECT pg_temp.patch_fn('admin_reg_field_save(text,text,boolean,jsonb,text,integer,boolean)'::regprocedure, ARRAY[
  $a$'columns', 'formula') THEN$a$, $b$'columns', 'formula', 'import_aliases') THEN$b$,
  $a$'label_en', 'label_ar', 'section', 'sort_order', 'in_list'$a$, $b$'label_en', 'label_ar', 'import_aliases', 'section', 'sort_order', 'in_list'$b$,
  $a$  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;$a$,
  $b$  IF p_patch ? 'import_aliases' AND (jsonb_typeof(p_patch -> 'import_aliases') <> 'array' OR jsonb_array_length(p_patch -> 'import_aliases') > 20
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_patch -> 'import_aliases') e WHERE jsonb_typeof(e) <> 'string' OR char_length(btrim(e #>> '{}')) > 200)) THEN
    errs := errs || public.reg_err_item('/import_aliases', 'invalid', 'A list of up to 20 alternative names, each up to 200 characters.');
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;$b$,
  $a$in_filter, in_template, in_export)$a$, $b$in_filter, in_template, in_export, import_aliases)$b$,
  $a$coalesce((p_patch ->> 'in_export')::boolean, true))$a$, $b$coalesce((p_patch ->> 'in_export')::boolean, true), public.rcol_aliases(p_patch -> 'import_aliases'))$b$,
  $a$  f.is_active := coalesce((p_patch ->> 'is_active')::boolean, f.is_active);$a$,
  $b$  f.is_active := coalesce((p_patch ->> 'is_active')::boolean, f.is_active);
  IF p_patch ? 'import_aliases' THEN f.import_aliases := public.rcol_aliases(p_patch -> 'import_aliases'); END IF;$b$,
  $a$in_export = f.in_export, is_active = f.is_active,$a$, $b$in_export = f.in_export, is_active = f.is_active, import_aliases = f.import_aliases,$b$]);

SELECT pg_temp.patch_fn('structure_diff(text,jsonb)'::regprocedure, ARRAY[
  $a$'in_export', 'is_active'] LOOP
        IF r ? k THEN patch$a$, $b$'in_export', 'is_active', 'import_aliases'] LOOP
        IF r ? k THEN patch$b$,
  $a$      IF r ? 'required' AND (r ->> 'required')::boolean IS DISTINCT FROM f.required THEN$a$,
  $b$      IF r ? 'import_aliases' AND public.rcol_aliases(r -> 'import_aliases') IS DISTINCT FROM f.import_aliases THEN
        changes := array_append(changes, 'aliases'::text); patch := patch || jsonb_build_object('import_aliases', r -> 'import_aliases');
      END IF;
      IF r ? 'required' AND (r ->> 'required')::boolean IS DISTINCT FROM f.required THEN$b$]);

SELECT pg_temp.patch_fn('admin_structure_proposal_revert(uuid,text)'::regprocedure, ARRAY[
  $a$'in_export', b -> 'in_export', 'is_active', b -> 'is_active'))$a$,
  $b$'in_export', b -> 'in_export', 'is_active', b -> 'is_active') || CASE WHEN b ? 'import_aliases' THEN jsonb_build_object('import_aliases', b -> 'import_aliases') ELSE '{}'::jsonb END)$b$]);
