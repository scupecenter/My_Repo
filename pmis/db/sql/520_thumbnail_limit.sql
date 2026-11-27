-- 0521_thumbnail_limit: a rate limit for making thumbnails in the Media gallery (SEC-2 of the phase 1 security review, 2026-11-27).
-- Mirror: db/sql/520_thumbnail_limit.sql (kept identical to prisma/migrations/0521_thumbnail_limit/migration.sql).
-- Depends on 0402_ops_limits (the ops.limits setting and ops_limits_catalogue()).
--
-- One more limit in the existing Settings > Security > Limits list, not a new setting (one place per kind of thing): media.thumbnails_per_minute,
-- per person per minute, default 120, range 0 to 6000, 0 = no limit. It counts only a thumbnail that has to be made; one already made is served free.
-- ops_limits_catalogue() is an accumulating function, so it is patched in place (its stored text gets one more row) and never rebuilt from an old copy.
-- Idempotent: a second run finds the row and changes nothing. No table, no data written, no permission widened, the enforcement is in the API (in memory per person).

DO $$
DECLARE d text; tail constant text := E'''max'', 100000))';
BEGIN
  SELECT pg_get_functiondef('public.ops_limits_catalogue()'::regprocedure) INTO d;
  IF position('media.thumbnails_per_minute' IN d) > 0 THEN RETURN; END IF;
  IF (length(d) - length(replace(d, tail, ''))) / length(tail) <> 1 THEN
    RAISE EXCEPTION 'ops_limits_catalogue(): the end of the limit list was not found exactly once';
  END IF;
  d := replace(d, tail, E'''max'', 100000),\n    jsonb_build_object(''key'', ''media.thumbnails_per_minute'', ''group'', ''media'', ''unit'', ''per_minute'', ''default'', 120, ''min'', 0, ''max'', 6000))');
  EXECUTE d;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('thumbnail_limit_applied', 'workflow', NULL,
        jsonb_build_object('limit', 'media.thumbnails_per_minute', 'setting', 'ops.limits', 'default', 120, 'off', 0),
        'SEC-2: the thumbnail rate limit joins Settings > Security > Limits (migration 0521).');
