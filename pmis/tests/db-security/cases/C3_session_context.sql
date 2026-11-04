-- The verified session context (migration 0069, P1-DB-03, ADR 0003 section 6).
--
-- The application role could set app.user_id, app.region_ids, app.stepup and the other session settings itself, so any SQL it ran could name another user,
-- widen its regions or claim a step-up. The database now trusts only a context started by app_begin(ctx, sig), signed with a secret key that pmis_app does
-- not hold. These cases attack that: forged settings, a forged copy of the verified context, a replayed signature, an expired one, a wrong key, an inactive user.
--
-- A case with @actor runs in a legitimate verified context (the runner signs it with the test key, like the API). A case with "@actor none" signs by hand:
-- the body reads txid_current(), calls sign-context.mjs through psql (the path is {{SIGN}}) and calls app_begin itself.
-- Alice holds one assignment, CW Team Lead in Tripoli (region 1). Benghazi is region 5.

-- ---------------------------------------------------------------------------------------------------------------------
-- Positive controls: the legitimate context works
-- ---------------------------------------------------------------------------------------------------------------------
-- @case CX-01
-- @title A signed context for Alice derives her regions from the data: Tripoli only
-- @category session-context
-- @actor ALICE
-- @expect output 1
SELECT app_ctx_regions();
-- @end

-- @case CX-02
-- @title The same context makes Alice the actor, and not an admin
-- @category session-context
-- @actor ALICE
-- @expect output true|false
SELECT (app_actor() = '{{ALICE}}')::text || '|' || app_actor_is_system_admin()::text;
-- @end

-- @case CX-03
-- @title A signed context for the System Admin derives all regions and the admin status from the data
-- @category session-context
-- @actor ADMIN
-- @expect output *|true
SELECT app_ctx_regions() || '|' || app_ctx_is_admin()::text;
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- No context at all: nothing is visible, nobody acts
-- ---------------------------------------------------------------------------------------------------------------------
-- @case CX-10
-- @title No context: the actor is NULL, even with app.user_id naming the System Admin
-- @category session-context
-- @actor none
-- @expect output true
SET app.user_id = '{{ADMIN}}';
SELECT (app_actor() IS NULL AND app_ctx_user() IS NULL AND NOT app_actor_is_system_admin())::text;
-- @end

-- @case CX-11
-- @title No context: a forged all-regions setting shows no row
-- @category session-context
-- @actor none
-- @expect output 0
SET app.region_ids = '*';
SELECT count(*) FROM clusters;
-- @end

-- @case CX-12
-- @title No context: a forged all-regions setting writes nothing (row-level security)
-- @category session-context
-- @actor none
-- @expect error 42501 row-level security
SET app.region_ids = '*';
INSERT INTO clusters (cluster_code, region_id, is_global) VALUES ('SEC-FORGED-02', 5, false);
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- Forged plain settings inside a legitimate context
-- ---------------------------------------------------------------------------------------------------------------------
-- @case CX-20
-- @title Alice forges app.user_id with the System Admin's id: she stays Alice and is no admin
-- @category session-context
-- @actor ALICE
-- @expect output true|false
SET app.user_id = '{{ADMIN}}';
SELECT (app_actor() = '{{ALICE}}')::text || '|' || app_actor_is_system_admin()::text;
-- @end

-- @case CX-21
-- @title Alice forges app.user_id with the System Admin's id: an admin-only function still refuses her
-- @category session-context
-- @actor ALICE
-- @expect error 42501 System Admin or a delegation covering users.edit required
SET app.user_id = '{{ADMIN}}';
SELECT idm_set_user_status('{{CAROL}}', 'suspended', 'Forged by SQL');
-- @end

-- @case CX-22
-- @title Alice forges app.region_ids and app.user_id together: she still sees no Benghazi row
-- @category session-context
-- @actor ALICE
-- @expect output 0
SET app.user_id = '{{ADMIN}}';
SET app.region_ids = '*';
SELECT count(*) FROM clusters WHERE cluster_code = 'SEC-BEN-01';
-- @end

-- @case CX-23
-- @title Alice claims a step-up and an MFA login with plain settings: the database says neither
-- @category session-context
-- @actor ALICE
-- @expect output false|
SET app.stepup = 'true';
SET app.mfa = 'true';
SELECT app_ctx_stepup()::text || '|' || coalesce(log_ctx('mfa'), '');
-- @end

-- @case CX-24
-- @title Alice forges the audit labels (ip, session, job): the database reads the signed values only
-- @category session-context
-- @actor ALICE
-- @expect output true
SET app.ip = '203.0.113.9';
SET app.session_id = '00000000-0000-4000-8000-0000000000ee';
SET app.job_name = 'forged_job';
SELECT (log_ctx('ip') IS NULL AND log_ctx('session_id') IS NULL AND log_ctx('job_name') IS NULL)::text;
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- A tampered or copied copy of the verified context
-- ---------------------------------------------------------------------------------------------------------------------
-- @case CX-30
-- @title Alice edits app.ctx to say she is an admin: the MAC no longer fits, the context is void
-- @category session-context
-- @actor ALICE
-- @expect output true|false
SELECT set_config('app.ctx', replace(current_setting('app.ctx'), '"ad": false', '"ad": true'), true);
SELECT (app_actor() IS NULL)::text || '|' || app_ctx_is_admin()::text;
-- @end

-- @case CX-31
-- @title Alice edits app.ctx to widen her regions to all regions: no Benghazi row appears
-- @category session-context
-- @actor ALICE
-- @expect output 0
SELECT set_config('app.ctx', replace(current_setting('app.ctx'), '"rg": "1"', '"rg": "*"'), true);
SELECT count(*) FROM clusters WHERE cluster_code = 'SEC-BEN-01';
-- @end

-- @case CX-32
-- @title Alice edits app.ctx to name the System Admin as the user: the context is void
-- @category session-context
-- @actor ALICE
-- @expect output true
SELECT set_config('app.ctx', replace(current_setting('app.ctx'), '{{ALICE}}', '{{ADMIN}}'), true);
SELECT (app_actor() IS NULL)::text;
-- @end

-- @case CX-33
-- @title Alice overwrites app.ctx_mac: the context is void and nothing is visible
-- @category session-context
-- @actor ALICE
-- @expect output true|0
SELECT set_config('app.ctx_mac', '1.' || repeat('0', 64), true);
SELECT (app_actor() IS NULL)::text || '|' || (SELECT count(*) FROM clusters);
-- @end

-- @case CX-34
-- @title A MAC copied from another transaction does not verify in this one
-- @category session-context
-- @actor none
-- @expect output true
SELECT txid_current() AS txid \gset
\set wire `node {{SIGN}} :txid {{ALICE}}`
SELECT app_begin(:'wire'::jsonb -> 'ctx', decode(:'wire'::jsonb ->> 'sig', 'hex')) AS began \gset
SELECT current_setting('app.ctx') AS c1, current_setting('app.ctx_mac') AS m1 \gset
COMMIT;
BEGIN;
SELECT set_config('app.ctx', :'c1', true), set_config('app.ctx_mac', :'m1', true);
SELECT (app_actor() IS NULL AND app_ctx_regions() = '')::text;
-- @end

-- @case CX-35
-- @title A TEMP table named like a context table, made by the application role, is not a context
-- @category session-context
-- @actor none
-- @expect output true
CREATE TEMP TABLE pmis_ctx (user_id uuid, region_ids text, is_admin boolean) ON COMMIT DROP;
INSERT INTO pmis_ctx VALUES ('{{ADMIN}}', '*', true);
SELECT (app_actor() IS NULL AND app_ctx_regions() = '' AND NOT app_ctx_is_admin())::text;
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- app_begin refuses what it must refuse
-- ---------------------------------------------------------------------------------------------------------------------
-- @case CX-40
-- @title A signature made for another transaction is refused (replay)
-- @category session-context
-- @actor none
-- @expect error 28000 bad signature
SELECT txid_current() AS txid \gset
\set wire `node {{SIGN}} :txid {{ALICE}}`
COMMIT;
BEGIN;
SELECT app_begin(:'wire'::jsonb -> 'ctx', decode(:'wire'::jsonb ->> 'sig', 'hex'));
-- @end

-- @case CX-41
-- @title A context issued two minutes ago is refused (expired)
-- @category session-context
-- @actor none
-- @expect error 28000 expired
SELECT txid_current() AS txid \gset
\set wire `node {{SIGN}} :txid {{ALICE}} issued=-120`
SELECT app_begin(:'wire'::jsonb -> 'ctx', decode(:'wire'::jsonb ->> 'sig', 'hex'));
-- @end

-- @case CX-42
-- @title A context issued in the future is refused
-- @category session-context
-- @actor none
-- @expect error 28000 expired
SELECT txid_current() AS txid \gset
\set wire `node {{SIGN}} :txid {{ALICE}} issued=3600`
SELECT app_begin(:'wire'::jsonb -> 'ctx', decode(:'wire'::jsonb ->> 'sig', 'hex'));
-- @end

-- @case CX-43
-- @title A signature made with a key the database does not hold is refused
-- @category session-context
-- @actor none
-- @expect error 28000 bad signature
SELECT txid_current() AS txid \gset
\set wire `node {{SIGN}} :txid {{ADMIN}} key=wrong`
SELECT app_begin(:'wire'::jsonb -> 'ctx', decode(:'wire'::jsonb ->> 'sig', 'hex'));
-- @end

-- @case CX-44
-- @title A valid signature for Alice does not carry a different user (the user id is part of the signed text)
-- @category session-context
-- @actor none
-- @expect error 28000 bad signature
SELECT txid_current() AS txid \gset
\set wire `node {{SIGN}} :txid {{ALICE}}`
SELECT app_begin(jsonb_set(:'wire'::jsonb -> 'ctx', '{user_id}', to_jsonb('{{ADMIN}}'::text)), decode(:'wire'::jsonb ->> 'sig', 'hex'));
-- @end

-- @case CX-45
-- @title An unsigned extra field in the context is refused
-- @category session-context
-- @actor none
-- @expect error 28000 malformed
SELECT txid_current() AS txid \gset
\set wire `node {{SIGN}} :txid {{ALICE}}`
SELECT app_begin((:'wire'::jsonb -> 'ctx') || '{"region_ids": "*"}'::jsonb, decode(:'wire'::jsonb ->> 'sig', 'hex'));
-- @end

-- @case CX-46
-- @title A correctly signed context for a disabled account is refused
-- @category session-context
-- @actor none
-- @expect error 28000 unknown or inactive user
SELECT txid_current() AS txid \gset
\set wire `node {{SIGN}} :txid {{DISABLED}}`
SELECT app_begin(:'wire'::jsonb -> 'ctx', decode(:'wire'::jsonb ->> 'sig', 'hex'));
-- @end

-- @case CX-47
-- @title A correctly signed context for a deleted account is refused
-- @category session-context
-- @actor none
-- @expect error 28000 unknown or inactive user
SELECT txid_current() AS txid \gset
\set wire `node {{SIGN}} :txid {{DELETED}}`
SELECT app_begin(:'wire'::jsonb -> 'ctx', decode(:'wire'::jsonb ->> 'sig', 'hex'));
-- @end

-- @case CX-48
-- @title A correctly signed context for an unknown user id is refused
-- @category session-context
-- @actor none
-- @expect error 28000 unknown or inactive user
SELECT txid_current() AS txid \gset
\set wire `node {{SIGN}} :txid 00000000-0000-4000-8000-0000000000dd`
SELECT app_begin(:'wire'::jsonb -> 'ctx', decode(:'wire'::jsonb ->> 'sig', 'hex'));
-- @end

-- @case CX-49
-- @title A signed context cannot name a delegation the user does not hold
-- @category session-context
-- @actor none
-- @expect error 28000 no such delegation
SELECT txid_current() AS txid \gset
\set wire `node {{SIGN}} :txid {{ALICE}} on_behalf={{DLG_ALL}}`
SELECT app_begin(:'wire'::jsonb -> 'ctx', decode(:'wire'::jsonb ->> 'sig', 'hex'));
-- @end

-- @case CX-50
-- @title A signed step-up in the past is not a step-up; one in the future is (the signed value, never a plain setting)
-- @category session-context
-- @actor none
-- @expect output false|true
SELECT txid_current() AS txid \gset
\set wire `node {{SIGN}} :txid {{ALICE}} stepup=-60`
SELECT app_begin(:'wire'::jsonb -> 'ctx', decode(:'wire'::jsonb ->> 'sig', 'hex')) AS began \gset
SELECT app_ctx_stepup()::text AS past \gset
COMMIT;
BEGIN;
SELECT txid_current() AS txid \gset
\set wire `node {{SIGN}} :txid {{ALICE}} stepup=300`
SELECT app_begin(:'wire'::jsonb -> 'ctx', decode(:'wire'::jsonb ->> 'sig', 'hex')) AS began \gset
SELECT :'past' || '|' || app_ctx_stepup()::text;
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- The key and the doors
-- ---------------------------------------------------------------------------------------------------------------------
-- @case CX-60
-- @title The application role cannot read the context keys
-- @category session-context
-- @actor ALICE
-- @expect error 42501 permission denied
SELECT count(*) FROM pmis_context_keys;
-- @end

-- @case CX-61
-- @title The application role cannot install a context key
-- @category session-context
-- @actor ALICE
-- @expect error 42501 permission denied
SELECT app_ctx_key_install(repeat('ab', 32));
-- @end

-- @case CX-62
-- @title The application role cannot pause the actor of the context
-- @category session-context
-- @actor ALICE
-- @expect error 42501 permission denied
SELECT app_ctx_pause(true);
-- @end

-- @case CX-63
-- @title The application role cannot forge the pause token either: the actor stays
-- @category session-context
-- @actor ALICE
-- @expect output true
SELECT set_config('app.ctx_pause', '1.' || repeat('0', 64), true);
SELECT (app_actor() = '{{ALICE}}')::text;
-- @end
