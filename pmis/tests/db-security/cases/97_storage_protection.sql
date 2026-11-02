-- Storage protection (migration 0048, owner answer Q134). The envelopes of stored objects (stored_object_meta) are read and written only through
-- the storage_* functions, which are owned by pmis_definer. The application role reads none of the table and cannot plant an envelope, a scan
-- verdict or a purge mark. Alice is an ordinary user with one CW entry assignment.

-- @case STO-01
-- @title Alice reads the envelopes of stored files (wrapped keys, tags) directly
-- @category storage-protection
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT count(*) FROM stored_object_meta;
-- @end

-- @case STO-02
-- @title Alice plants an envelope for an object of her choosing
-- @category storage-protection
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO stored_object_meta (storage_key, driver, key_id, wrapped_key, nonce, tag, plain_sha256, size_bytes)
VALUES ('docs/2026/11/forged-object', 'local', 'k1', decode(repeat('00', 60), 'hex'), decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'), repeat('0', 64), 1);
-- @end

-- @case STO-03
-- @title Alice clears the malware flag of a file through the table
-- @category storage-protection
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE stored_object_meta SET scan_status = 'clean';
-- @end

-- @case STO-04
-- @title Alice marks an export as purged without the purge job
-- @category storage-protection
-- @actor ALICE
-- @region 1
-- @expect ok
SELECT storage_export_purged('00000000-0000-0000-0000-000000000000'::uuid);
-- @end

-- @case STO-05
-- @title Alice writes a scan verdict of an unknown status through the function
-- @category storage-protection
-- @actor ALICE
-- @region 1
-- @expect error 23514 storage meta
SELECT storage_meta_put('docs/2026/11/bad-status', 'local', 'k1', decode(repeat('00', 60), 'hex'), decode(repeat('00', 12), 'hex'),
  decode(repeat('00', 16), 'hex'), repeat('0', 64), 1, 'infected', false);
-- @end

-- @case STO-06
-- @title Alice raises a malware alert of her choosing (the alert is the System Admins' inbox)
-- @category storage-protection
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO security_alerts (rule, severity, title, dedup_key) VALUES ('malware_upload', 'high', 'forged', 'forged-1');
-- @end

-- @case STO-07
-- @title Alice rewraps a data key of an object (key rotation is for the operator)
-- @category storage-protection
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE stored_object_meta SET key_id = 'forged', wrapped_key = decode(repeat('00', 60), 'hex');
-- @end
