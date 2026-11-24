-- GSDN Workspace: reset the PROJECT DATA of a server, keeping users, accounts and configuration (owner request and approved scope, 2026-11-23).
-- The reviewable contract of this file is docs/ops/data-reset.md: every table of the public schema is listed there as KEEP, DELETE or MIXED with
-- its reason. Since migration 0146 the plan (data_reset_plan) and the reset itself (data_reset_core: counts, deletes, checks, end of the sessions, the
-- audit row) live in the database, and the Settings page (Settings > Data reset, two System Admins) calls the same function: there is one copy of the
-- table list. This file is the operator's wrapper. Run it only through infra/scripts/reset-project-data.sh, as the superuser, while the API is stopped:
--
--   psql -X -v ON_ERROR_STOP=1 -At -F '|' -v execute=false -v reason='...' -v operator='...' -v backup='...' [-v parts=a,b] -d pmis -f reset-project-data.sql
--
-- parts (migration 0152): a comma-separated list of part codes (data_reset_parts(); docs/ops/data-reset.md, "Parts"). Empty or unset: everything as
--   before 0152 (every project part, no identity part). The database adds the dependent parts (data_reset_closure) and prints them on the SCOPE line.
--
-- execute=false (dry run): counts only, then ROLLBACK. Nothing is written but the session's own temporary tables, and no lock stronger than a read
--   lock is taken, so it is safe while the API runs.
-- execute=true: ONE transaction. data_reset_core deletes the DELETE tables and the project rows of the MIXED tables, checks that no KEEP table and no kept
--   row of a MIXED table lost or gained a row (RAISE EXCEPTION otherwise: everything rolls back), ends every open session, writes one audit row (action
--   project_data_reset, counts only) on the audit hash chain, checks the chains moved exactly as expected; then COMMIT. It refuses while a reset approved in
--   Settings waits to run or runs, and Settings refuses while this one runs (the advisory lock 353383097684 of data_reset_core).
--
-- Output lines (for the script): SCOPE|parts|added by the dependencies|hash, PART|code|rows, PLAN|table|action|rows_now|rows_to_delete|rows_kept, FILE|storage_key (execute only: the stored objects of the
-- deleted rows, to be moved to the quarantine directory after the commit), DONE|audit_id|sessions_ended|files.
--
-- The Audit Log, the security log, their chains, the System Log and the other logs are never deleted or altered: they are KEEP tables, and their own
-- triggers refuse it anyway. No trigger is disabled and no table truncated: the row guards that refuse every DELETE let the reset role through only
-- inside the running reset (data_reset_marker). See docs/ops/data-reset.md, section "Guards".

\set ON_ERROR_STOP 1
\if :{?execute}
\else
  \echo 'reset-project-data.sql: set -v execute=true|false'
  \quit
\endif
\if :{?reason}
\else
  \set reason ''
\endif
\if :{?operator}
\else
  \set operator ''
\endif
\if :{?backup}
\else
  \set backup ''
\endif
\if :{?parts}
\else
  \set parts ''
\endif

SET client_min_messages = warning;
BEGIN;   -- READ COMMITTED: data_reset_core locks every table of the plan first, then each statement sees all that was committed before the locks
SET LOCAL lock_timeout = '60s';
SET LOCAL statement_timeout = 0;
SELECT set_config('pmis.reset_execute', :'execute', true) \g /dev/null
SELECT set_config('pmis.reset_reason', :'reason', true) \g /dev/null
SELECT set_config('pmis.reset_operator', :'operator', true) \g /dev/null
SELECT set_config('pmis.reset_backup', :'backup', true) \g /dev/null
SELECT set_config('pmis.reset_parts', :'parts', true) \g /dev/null

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'reset-project-data: run as the database superuser (sudo -u postgres psql)';
  END IF;
  IF to_regprocedure('public.data_reset_core(boolean,text,jsonb,uuid,uuid,text[],uuid[])') IS NULL THEN
    RAISE EXCEPTION 'reset-project-data: the database has no selectable data_reset_core (migration 0152 is not applied): update the server first';
  END IF;
END $$;

CREATE TEMP TABLE reset_out ON COMMIT DROP AS
SELECT public.data_reset_core(current_setting('pmis.reset_execute')::boolean, current_setting('pmis.reset_reason'),
  CASE WHEN current_setting('pmis.reset_execute')::boolean THEN jsonb_build_object(
    'operator', nullif(current_setting('pmis.reset_operator'), ''),
    'backup', nullif(current_setting('pmis.reset_backup'), ''),
    'via', 'infra/scripts/reset-project-data.sh') END,
  NULL, NULL, string_to_array(nullif(current_setting('pmis.reset_parts'), ''), ','), NULL) AS r;

SELECT 'SCOPE', array_to_string(ARRAY(SELECT jsonb_array_elements_text(r -> 'scope' -> 'parts')), ','),
       array_to_string(ARRAY(SELECT jsonb_array_elements_text(r -> 'scope' -> 'added')), ','), r -> 'scope' ->> 'hash'
FROM reset_out;
SELECT 'PART', e ->> 'code', e ->> 'rows' FROM reset_out, jsonb_array_elements(r -> 'parts') AS e ORDER BY e ->> 'code';

SELECT 'PLAN', e ->> 'tbl', e ->> 'action', e ->> 'rows', e ->> 'delete', e ->> 'keep'
FROM reset_out, jsonb_array_elements(r -> 'plan') WITH ORDINALITY AS x(e, n) ORDER BY n;

\if :execute
SELECT 'FILE', k FROM reset_out, jsonb_array_elements_text(r -> 'files') AS k ORDER BY k;
SELECT 'DONE', r ->> 'audit_id', r ->> 'sessions_ended', jsonb_array_length(r -> 'files') FROM reset_out;
COMMIT;
\else
ROLLBACK;
\endif
