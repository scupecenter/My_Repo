-- Row-level security on region data, and session rows.
--
-- RL-01 and RL-04 check the region filter as it is meant to work: a Tripoli session sees no Benghazi row, and cannot write
-- one. They must pass.
--
-- RL-02, RL-03 and SS-01 are KNOWN LIMITS (ADR 0003 section 6, P0 gate report section 3, task P1-DB-03). The application
-- passes the region filter and the actor as plain session settings, and the application role holds INSERT on user_sessions.
-- They are kept here as negative cases on purpose. They FAIL until P1-DB-03 (a signed session context verified in the
-- database) and a session-creation function are in place. Do not edit them to pass.

-- @case RL-01
-- @title A Tripoli session does not see the Benghazi cluster
-- @category rls
-- @actor ALICE
-- @region 1
-- @expect output 0
SELECT count(*) FROM clusters WHERE cluster_code = 'SEC-BEN-01';
-- @end

-- @case RL-02
-- @title KNOWN LIMIT: a forged all-regions setting in a Tripoli session reads the Benghazi cluster (P1-DB-03)
-- @category known-limit
-- @actor ALICE
-- @region *
-- @expect output 0
SELECT count(*) FROM clusters WHERE cluster_code = 'SEC-BEN-01';
-- @end

-- @case RL-03
-- @title KNOWN LIMIT: a forged all-regions setting in a Tripoli session writes a Benghazi cluster (P1-DB-03)
-- @category known-limit
-- @actor ALICE
-- @region *
-- @expect error 42501 row-level security
INSERT INTO clusters (cluster_code, region_id, is_global) VALUES ('SEC-FORGED-01', 5, false);
-- @end

-- @case RL-04
-- @title A Tripoli session cannot write a Benghazi cluster (row-level security, no forgery)
-- @category rls
-- @actor ALICE
-- @region 1
-- @expect error 42501 row-level security
INSERT INTO clusters (cluster_code, region_id, is_global) VALUES ('SEC-BEN-02', 5, false);
-- @end

-- @case SS-01
-- @title KNOWN LIMIT: the application role inserts a live session row for the System Admin from a chosen token
-- @category known-limit
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO user_sessions (token_hash, user_id, auth_method, csrf_token, expires_at)
VALUES (encode(sha256('secsuite-forged-token'::bytea), 'hex'), '{{ADMIN}}', 'local', 'forged-csrf', now() + interval '1 hour');
-- @end
