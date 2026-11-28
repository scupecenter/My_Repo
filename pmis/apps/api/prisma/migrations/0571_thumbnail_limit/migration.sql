-- 0571_thumbnail_limit: a rate limit for making thumbnails in the Media gallery (SEC-2 of the phase 1 security review, 2026-11-27).
-- Mirror: db/sql/570_thumbnail_limit.sql (kept identical to prisma/migrations/0571_thumbnail_limit/migration.sql).
-- Depends on 0402_ops_limits (the ops.limits setting and ops_limits_catalogue()).
--
-- One more limit in the existing Settings > Security > Limits list, not a new setting (one place per kind of thing): media.thumbnails_per_minute,
-- per person per minute, default 120, range 0 to 6000, 0 = no limit. It counts only a thumbnail that has to be made; one already made is served free.
-- ops_limits_catalogue() is an accumulating function, so it is patched in place (its stored text gets one more row) and never rebuilt from an old copy.
-- Idempotent: a second run finds the row and changes nothing. No table, no data written, no permission widened, the enforcement is in the API (in memory per person).

DO $$
DECLARE
  d text;
  cand text[] := ARRAY[E'''max'', 50))', E'''max'', 100000))'];
  tail text;
  n int;
  hits int := 0;
BEGIN
  SELECT pg_get_functiondef('public.ops_limits_catalogue()'::regprocedure) INTO d;
  IF position('media.thumbnails_per_minute' IN d) > 0 THEN RETURN; END IF;
  -- The list ends with the last entry of the migration that touched it last (login limits: 'max', 50; before them idempotency.max_entries: 'max', 100000).
  -- Patch whichever end is there, exactly once, so this works after either of them.
  FOREACH tail IN ARRAY cand LOOP
    n := (length(d) - length(replace(d, tail, ''))) / length(tail);
    IF n = 1 THEN
      d := replace(d, tail, left(tail, length(tail) - 1) || E',\n    jsonb_build_object(''key'', ''media.thumbnails_per_minute'', ''group'', ''media'', ''unit'', ''per_minute'', ''default'', 120, ''min'', 0, ''max'', 6000))');
      hits := 1;
      EXIT;
    END IF;
  END LOOP;
  IF hits <> 1 THEN
    RAISE EXCEPTION 'ops_limits_catalogue(): the end of the limit list was not found';
  END IF;
  EXECUTE d;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('thumbnail_limit_applied', 'workflow', NULL,
        jsonb_build_object('limit', 'media.thumbnails_per_minute', 'setting', 'ops.limits', 'default', 120, 'off', 0),
        'SEC-2: the thumbnail rate limit joins Settings > Security > Limits (migration 0571).');
