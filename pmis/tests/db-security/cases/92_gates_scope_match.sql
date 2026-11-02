-- The gate-lock exempt list and the team / scope match of Procurement (migration 0043, owner decision 2026-11-02 and Q97). The application role reads
-- the three match tables but never writes them: the only writer is admin_save_team_scope_match (System Admin or a delegation of admin.settings edit
-- for all regions, a reason, the version, an audit row). The check function behind the Procurement trigger is not callable from the application role.
-- The exempt list lives in settings, whose row-level policies let only a holder of settings.edit change it.
-- Alice holds one CW entry assignment (module sites); DEL_ALL is a delegate for users, assignments and groups, not for Settings.

-- @case GS-01
-- @title Alice allows every team on every scope by writing a cell of the match table directly
-- @category gates-scope-match
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE team_scope_match SET allowed = true;
-- @end

-- @case GS-02
-- @title Alice plants a new allowed cell for a specialization of her choosing
-- @category gates-scope-match
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO team_scope_match (scope, specialization, allowed) VALUES ('TE Installation', 'Anything', true);
-- @end

-- @case GS-03
-- @title Alice makes every scope exempt, so no order is checked any more
-- @category gates-scope-match
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE team_scope_match_scopes SET exempt = true;
-- @end

-- @case GS-04
-- @title Alice deletes the scopes of the match table (and with them every cell)
-- @category gates-scope-match
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM team_scope_match_scopes;
-- @end

-- @case GS-05
-- @title Alice bumps the version of the match table to break the If-Match of the admin
-- @category gates-scope-match
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE team_scope_match_meta SET version = version + 1;
-- @end

-- @case GS-06
-- @title Alice, who has no Settings right, saves the match table through the admin function
-- @category gates-scope-match
-- @actor ALICE
-- @region 1
-- @expect error 42501 delegation covering admin.settings.edit required
SELECT admin_save_team_scope_match('{"specializations": ["CW"], "scopes": [{"scope": "TE Installation", "exempt": false, "allowed": ["CW"]}]}'::jsonb, 'Forged by SQL', NULL);
-- @end

-- @case GS-07
-- @title A delegate of users, assignments and groups (no Settings right) saves the match table
-- @category gates-scope-match
-- @actor DEL_ALL
-- @region *
-- @expect error 42501 delegation covering admin.settings.edit required
SELECT admin_save_team_scope_match('{"specializations": ["CW"], "scopes": []}'::jsonb, 'Delegate tries Settings', NULL);
-- @end

-- @case GS-08
-- @title The System Admin saves with a stale version: refused, nothing is written
-- @category gates-scope-match
-- @actor ADMIN
-- @region *
-- @expect error P0001 precondition_failed
SELECT admin_save_team_scope_match('{"specializations": ["CW", "TE"], "scopes": []}'::jsonb, 'Stale version', 999999);
-- @end

-- @case GS-09
-- @title Alice calls the internal check of the Procurement trigger
-- @category gates-scope-match
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT team_scope_problem('CW', gen_random_uuid());
-- @end

-- @case GS-10
-- @title Alice reads the match table (read-only for everyone signed in)
-- @category gates-scope-match
-- @actor ALICE
-- @region 1
-- @expect output >= 1
SELECT count(*) FROM team_scope_match WHERE allowed;
-- @end

-- @case GS-11
-- @title Alice widens the gate-lock exempt list to every task (the settings policies keep her out: no row changes)
-- @category gates-scope-match
-- @actor ALICE
-- @region 1
-- @expect output 0
WITH u AS (UPDATE settings SET value = '["*"]' WHERE key = 'calc.gate_lock_exempt_tasks' RETURNING 1) SELECT count(*) FROM u;
-- @end
