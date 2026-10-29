-- auth_local_lookup (ADR 0012): the sign-in lookup, run before any session exists. It must never return a deleted account
-- (migration 0012 disables it and switches its local sign-in off) or a disabled account, whatever identifier is typed.
-- The identifiers are the synthetic ones from 01_fixtures.sql: employee ID, e-mail and phone for each account.

-- Deleted account (soft delete, migration 0012)
-- @case LK-01
-- @title Lookup by e-mail of a deleted account returns nothing
-- @category local-lookup
-- @expect output 0
SELECT count(*) FROM auth_local_lookup('deleted.sec@example.test');
-- @end

-- @case LK-02
-- @title Lookup by employee ID of a deleted account returns nothing
-- @category local-lookup
-- @expect output 0
SELECT count(*) FROM auth_local_lookup('1009');
-- @end

-- @case LK-03
-- @title Lookup by phone of a deleted account returns nothing
-- @category local-lookup
-- @expect output 0
SELECT count(*) FROM auth_local_lookup('+218910000010');
-- @end

-- Disabled account (status disabled, not deleted)
-- @case LK-04
-- @title Lookup by e-mail of a disabled account returns nothing
-- @category local-lookup
-- @expect output 0
SELECT count(*) FROM auth_local_lookup('disabled.sec@example.test');
-- @end

-- @case LK-05
-- @title Lookup by employee ID of a disabled account returns nothing
-- @category local-lookup
-- @expect output 0
SELECT count(*) FROM auth_local_lookup('1008');
-- @end

-- @case LK-06
-- @title Lookup by phone of a disabled account returns nothing
-- @category local-lookup
-- @expect output 0
SELECT count(*) FROM auth_local_lookup('+218910000009');
-- @end
