-- Local credentials (ADR 0012). The application role reads password hashes only through the functions, and each function
-- works only for the signed-in user's own row. Nobody reads another person's hash.

-- @case LC-01
-- @title Alice reads the password hashes directly
-- @category local-credentials
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT password_hash FROM local_credentials;
-- @end

-- @case LC-02
-- @title Alice reads Bob's credential row through auth_local_own_hash
-- @category local-credentials
-- @actor ALICE
-- @region 1
-- @expect error 42501 only your own credentials
SELECT count(*) FROM auth_local_own_hash('{{BOB}}');
-- @end

-- @case LC-03
-- @title Alice sets Bob's password through auth_local_set_own_password
-- @category local-credentials
-- @actor ALICE
-- @region 1
-- @expect error 42501 only your own password
SELECT auth_local_set_own_password('{{BOB}}', '{{HASH}}');
-- @end

-- @case LC-04
-- @title Anonymous session reads Alice's credential row (no signed-in user)
-- @category local-credentials
-- @expect error 42501 only your own credentials
SELECT count(*) FROM auth_local_own_hash('{{ALICE}}');
-- @end
