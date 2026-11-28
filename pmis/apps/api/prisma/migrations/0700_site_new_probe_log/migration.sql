-- 0700: DIAGNOSTIC ONLY, no behaviour change. site_new_clean checks the scope against the scenario rules with a probe site in a subtransaction that is rolled back. Any error inside
-- the probe is shown to the person as "The site could not be checked against the scenario rules." and the real error was thrown away, so a rare failure (seen on the shared test
-- database, rows of a big batch refused with that text) could not be traced. This migration adds one RAISE LOG line with the SQLSTATE and the message to that branch, so the
-- cause is in the database log. The text the person sees, the result of the function, the rows and the rights stay exactly as they are.
-- Additive: an in-place patch of the stored text of site_new_clean (asserted: the old text is found exactly once, or the new line is there already; idempotent). No table, no grant.

CREATE OR REPLACE FUNCTION pg_temp.patch_fn(sig regprocedure, pairs text[]) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE d text := pg_get_functiondef(sig); i int; o text; n text;
BEGIN
  FOR i IN 1 .. array_length(pairs, 1) / 2 LOOP
    o := pairs[2 * i - 1]; n := pairs[2 * i];
    IF position(n IN d) > 0 THEN CONTINUE; END IF;
    IF (length(d) - length(replace(d, o, ''))) / length(o) <> 1 THEN RAISE EXCEPTION '0700: % not found exactly once in %', left(o, 60), sig; END IF;
    d := replace(d, o, n);
  END LOOP;
  EXECUTE d;
END $f$;

SELECT pg_temp.patch_fn('site_new_clean(jsonb,uuid)'::regprocedure, ARRAY[
  $a$          errs := errs || public.site_new_err('delivery_scenario', 'invalid', 'The site could not be checked against the scenario rules.');$a$,
  $b$          RAISE LOG 'site_new_clean probe failed: sqlstate % message %', SQLSTATE, SQLERRM;   -- 0700 diagnostic
          errs := errs || public.site_new_err('delivery_scenario', 'invalid', 'The site could not be checked against the scenario rules.');$b$]);
