-- Site identity changes (migration 0071, technical decision Q473; contract 0.14.1). The identity of a site (Site ID, English and Arabic name, coordinates, region,
-- cluster) changes only through an approved Change Control proposal (p4a_apply_site_change, owner pmis_definer) and is set at creation by site_create_apply. The
-- application role cannot update those columns, not even a System Admin through it, cannot call the old region-transfer function (dropped) or the internal
-- writers, and the proposal function refuses the Site ID, and a region or a cluster for anybody who is not a System Admin.
-- Alice: CW Team Lead in Tripoli (sites view and edit there), not a System Admin. SITE_TRI (Tripoli) and SITE_BEN (Benghazi) come from the fixtures.

-- ---------------------------------------------------------------------------------------------------------------------
-- No direct update of the identity columns (the privilege is the first wall)
-- ---------------------------------------------------------------------------------------------------------------------
-- @case SI-01
-- @title Alice renames a site directly (English name)
-- @category site-identity
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE sites SET name = 'Renamed directly' WHERE id = '{{SITE_TRI}}';
-- @end

-- @case SI-02
-- @title Alice sets the Arabic name directly
-- @category site-identity
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE sites SET name_ar = 'اسم مباشر' WHERE id = '{{SITE_TRI}}';
-- @end

-- @case SI-03
-- @title Alice moves the coordinates directly
-- @category site-identity
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE sites SET latitude = 10, longitude = 10 WHERE id = '{{SITE_TRI}}';
-- @end

-- @case SI-04
-- @title Alice moves a site to another region directly (who can see it would change)
-- @category site-identity
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE sites SET region_id = 5 WHERE id = '{{SITE_TRI}}';
-- @end

-- @case SI-05
-- @title Alice puts a site into a cluster directly
-- @category site-identity
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE sites SET cluster_id = (SELECT id FROM clusters WHERE cluster_code = 'SEC-TRI-01') WHERE id = '{{SITE_TRI}}';
-- @end

-- @case SI-06
-- @title Alice changes a Site ID directly
-- @category site-identity
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE sites SET site_code = 'SEC-TRI-S9' WHERE id = '{{SITE_TRI}}';
-- @end

-- @case SI-07
-- @title The System Admin renames a site directly: an admin has no direct path either
-- @category site-identity
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE sites SET name = 'Admin direct rename' WHERE id = '{{SITE_TRI}}';
-- @end

-- @case SI-08
-- @title The System Admin changes the region directly
-- @category site-identity
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE sites SET region_id = 5 WHERE id = '{{SITE_TRI}}';
-- @end

-- @case SI-09
-- @title The System Admin changes a Site ID directly
-- @category site-identity
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE sites SET site_code = 'SEC-TRI-S8' WHERE id = '{{SITE_TRI}}';
-- @end

-- @case SI-10
-- @title The old region-transfer function is gone: the System Admin cannot call it
-- @category site-identity
-- @actor ADMIN
-- @region *
-- @expect error 42883 does not exist
SELECT admin_transfer_site_region('{{SITE_TRI}}', 5, 'direct');
-- @end

-- @case SI-11
-- @title Alice cannot call the old region-transfer function either
-- @category site-identity
-- @actor ALICE
-- @region 1
-- @expect error 42883 does not exist
SELECT admin_transfer_site_region('{{SITE_TRI}}', 5, 'direct');
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- The internal writers and checks are not callable by the application role
-- ---------------------------------------------------------------------------------------------------------------------
-- @case SI-20
-- @title Alice calls the writer of the approved path, si_apply_identity, for a record
-- @category site-identity
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT si_apply_identity('00000000-0000-4000-8000-000000000999');
-- @end

-- @case SI-21
-- @title The System Admin calls p4a_apply_site_change directly: no path around L1 and L2
-- @category site-identity
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied for function
SELECT p4a_apply_site_change('00000000-0000-4000-8000-000000000999');
-- @end

-- @case SI-22
-- @title Alice calls the parser and the checker of the identity items
-- @category site-identity
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT si_check_item('{{SITE_TRI}}', 'site.name', 'X', NULL);
-- @end

-- @case SI-23
-- @title Alice calls the administrator test behind the region and cluster rule
-- @category site-identity
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT si_require_admin('the region');
-- @end

-- @case SI-24
-- @title Alice calls the three-argument parser of the site field values
-- @category site-identity
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT p4a_site_parse('{{SITE_TRI}}', 'site.region', 'Benghazi');
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- The proposal function: the Site ID, region and cluster
-- ---------------------------------------------------------------------------------------------------------------------
-- @case SI-30
-- @title Alice proposes a region change: it needs a System Admin (action_forbidden)
-- @category site-identity
-- @actor ALICE
-- @region 1
-- @expect error P0001 action_forbidden
SELECT site_propose_identity('{{SITE_TRI}}', '{"region_id": 5}'::jsonb, 'wrong region');
-- @end

-- @case SI-31
-- @title Alice proposes a cluster change: it needs a System Admin
-- @category site-identity
-- @actor ALICE
-- @region 1
-- @expect error P0001 action_forbidden
SELECT site_propose_identity('{{SITE_TRI}}', '{"cluster_code": "SEC-TRI-01"}'::jsonb, 'cluster');
-- @end

-- @case SI-32
-- @title Alice forges app.user_id with the System Admin's id and an all-regions setting: she stays Alice
-- @category site-identity
-- @actor ALICE
-- @region 1
-- @expect error P0001 action_forbidden
SET app.user_id = '{{ADMIN}}';
SET app.region_ids = '*';
SELECT site_propose_identity('{{SITE_TRI}}', '{"region_id": 5, "cluster_code": null}'::jsonb, 'forged');
-- @end

-- @case SI-33
-- @title Nobody signed in proposes an identity change
-- @category site-identity
-- @expect error 42501 no signed-in actor
SELECT site_propose_identity('{{SITE_TRI}}', '{"name": "Nobody"}'::jsonb, 'reason');
-- @end

-- @case SI-34
-- @title With no context, a forged user id of the System Admin proposes nothing
-- @category site-identity
-- @actor none
-- @region *
-- @expect error 42501 no signed-in actor
SET app.user_id = '{{ADMIN}}';
SELECT site_propose_identity('{{SITE_TRI}}', '{"region_id": 5}'::jsonb, 'forged');
-- @end

-- @case SI-35
-- @title Alice cannot see the site of Benghazi: a proposal for it is not_found
-- @category site-identity
-- @actor ALICE
-- @region 1
-- @expect error P0001 not_found
SELECT site_propose_identity('{{SITE_BEN}}', '{"name": "Not hers"}'::jsonb, 'reason');
-- @end

-- @case SI-36
-- @title The System Admin names the Site ID in a proposal: refused with the field error immutable
-- @category site-identity
-- @actor ADMIN
-- @region *
-- @expect error P0001 immutable
SELECT site_propose_identity('{{SITE_TRI}}', '{"site_code": "SEC-TRI-S7"}'::jsonb, 'new id');
-- @end

-- @case SI-37
-- @title The System Admin names the Site ID together with a good name: nothing is proposed, the Site ID is refused (immutable)
-- @category site-identity
-- @actor ADMIN
-- @region *
-- @expect error P0001 immutable
SELECT site_propose_identity('{{SITE_TRI}}', '{"name": "Fine name", "site_code": "SEC-TRI-S7"}'::jsonb, 'new id');
-- @end

-- @case SI-38
-- @title A cluster of Benghazi for a site of Tripoli is refused, also for the System Admin
-- @category site-identity
-- @actor ADMIN
-- @region *
-- @expect error P0001 cluster_other_region
SELECT site_propose_identity('{{SITE_TRI}}', '{"cluster_code": "SEC-BEN-01"}'::jsonb, 'wrong cluster');
-- @end

-- @case SI-39
-- @title A proposal without a reason is refused
-- @category site-identity
-- @actor ADMIN
-- @region *
-- @expect error P0001 validation_failed
SELECT site_propose_identity('{{SITE_TRI}}', '{"name": "No reason"}'::jsonb, '  ');
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- Controls and the shape of the functions
-- ---------------------------------------------------------------------------------------------------------------------
-- @case SI-90
-- @title Control: the application role keeps the update right on the other columns of sites, and no table-level update right
-- @category site-identity
-- @actor ALICE
-- @region 1
-- @expect output true|false|false|false
SELECT has_column_privilege('pmis_app', 'sites', 'custom', 'UPDATE') || '|' || has_table_privilege('pmis_app', 'sites', 'UPDATE')
  || '|' || has_column_privilege('pmis_app', 'sites', 'name', 'UPDATE') || '|' || has_column_privilege('pmis_app', 'sites', 'region_id', 'UPDATE');
-- @end

-- @case SI-91
-- @title Control: Alice still reads her own site, and the writer of the proposals is callable by the application role
-- @category site-identity
-- @actor ALICE
-- @region 1
-- @expect output 1|true
SELECT (SELECT count(*) FROM sites WHERE id = '{{SITE_TRI}}') || '|' || has_function_privilege('pmis_app', 'site_propose_identity(uuid,jsonb,text)', 'EXECUTE');
-- @end

-- @case SI-92
-- @title Every function of migration 0071 is SECURITY DEFINER with a fixed search path, owned by pmis_definer, closed to PUBLIC (the guard trigger runs as the caller by design)
-- @category site-identity
-- @actor ALICE
-- @region 1
-- @expect output 0
SELECT count(*) FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND (p.proname LIKE 'si\_%' OR p.proname IN ('site_propose_identity', 'p4a_site_current', 'p4a_site_change_errors', 'p4a_apply_site_change') OR (p.proname = 'p4a_site_parse' AND p.pronargs = 3))
  AND NOT (p.prosecdef AND pg_get_userbyid(p.proowner) = 'pmis_definer' AND p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']
           AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
           AND (has_function_privilege('pmis_app', p.oid, 'EXECUTE') = (p.proname = 'site_propose_identity')));
-- @end

-- @case SI-93
-- @title The guard trigger of the identity columns exists and the old region-transfer function does not
-- @category site-identity
-- @actor ALICE
-- @region 1
-- @expect output 1|0
SELECT (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.sites'::regclass AND tgname = 'b_sites_identity_guard' AND NOT tgisinternal)
  || '|' || (SELECT count(*) FROM pg_proc WHERE proname = 'admin_transfer_site_region');
-- @end
