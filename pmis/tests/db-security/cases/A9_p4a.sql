-- Migration 0062 (P4a, owner answers 2026-11-04 Q103, Q108, Q113, Q225): the typed projections that the gates, the delay and the dashboard read are
-- written only by the approval feeds (owner pmis_definer). The application role cannot forge a suspension, a resumption, a site change or an As-Built
-- part, cannot run a feed itself, and cannot edit a rule-affecting site field directly.

-- @case P4A-01
-- @title Alice forges an approved suspension in change_requests (it would lock every later gate of the site)
-- @category p4a_feeds
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO change_requests (change_code, site_id, region_id, kind, status, approval_date, suspension_start, requested_by)
VALUES ('SEC-FORGED-1', '{{SITE_TRI}}', 1, 'suspension', 'approved', current_date, current_date, '{{ALICE}}');
-- @end

-- @case P4A-02
-- @title Alice moves the effective resumption date of an approved change
-- @category p4a_feeds
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE change_requests SET resumption_date = current_date - 100, status = 'approved' WHERE site_id = '{{SITE_TRI}}';
-- @end

-- @case P4A-03
-- @title Alice deletes the change requests of a site (the suspension would stop counting)
-- @category p4a_feeds
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM change_requests WHERE site_id = '{{SITE_TRI}}';
-- @end

-- @case P4A-04
-- @title Alice runs the Change Control feed on a record herself
-- @category p4a_feeds
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT p4a_feed_change(gen_random_uuid());
-- @end

-- @case P4A-05
-- @title Alice applies a site field change without an approved Change Control
-- @category p4a_feeds
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT p4a_apply_site_change(gen_random_uuid());
-- @end

-- @case P4A-06
-- @title Alice writes the readiness projection (O&M acceptance closes HOTO)
-- @category p4a_feeds
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO readiness_handover (site_id, region_id, om_acceptance_date, closure_ready) VALUES ('{{SITE_TRI}}', 1, current_date, true);
-- @end

-- @case P4A-07
-- @title Alice writes the As-Built projection (BU / EF of the site)
-- @category p4a_feeds
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO as_built_records (site_id, region_id, quantities, cw_as_built_submitted, te_submitted_date) VALUES ('{{SITE_TRI}}', 1, '{}'::jsonb, 'Yes', current_date);
-- @end

-- @case P4A-08
-- @title Alice changes the Warehouse group behind an As-Built item-type field
-- @category p4a_feeds
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE as_built_type_sources SET item_group = 'CORE' WHERE field_code = 'router_type';
-- @end

-- @case P4A-09
-- @title Alice writes the issues and risks projections (health index inputs)
-- @category p4a_feeds
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE issues SET status = 'closed' WHERE site_id = '{{SITE_TRI}}';
-- @end

-- @case P4A-10
-- @title Alice switches off the approval requirement of near_airport (the row is not even visible to her: nothing changes)
-- @category p4a_feeds
-- @actor ALICE
-- @region 1
-- @expect output 0
WITH u AS (UPDATE field_definitions SET requires_approval = false WHERE code = 'near_airport' RETURNING 1) SELECT count(*) FROM u;
-- @end

-- @case P4A-10b
-- @title Alice adds a site field that claims to require approval through a plain table write
-- @category p4a_feeds
-- @actor ALICE
-- @region 1
-- @expect error 42501
INSERT INTO field_definitions (entity_type, code, label_en, data_type, requires_approval) VALUES ('site', 'sec_p4a_flag', 'Synthetic flag', 'bool', true);
-- @end

-- @case P4A-11
-- @title Even the System Admin cannot set near_airport directly: it needs an approved Change Control (Q225)
-- @category p4a_feeds
-- @actor ADMIN
-- @region *
-- @expect error P0001 approval_required
SELECT site_save_custom('{{SITE_TRI}}', NULL, '{"near_airport": true}'::jsonb, 'direct');
-- @end

-- @case P4A-12
-- @title A proposal without a reason is refused
-- @category p4a_feeds
-- @actor ADMIN
-- @region *
-- @expect error P0001 validation_failed
SELECT site_propose_change('{{SITE_TRI}}', '{"near_airport": true}'::jsonb, '  ');
-- @end

-- @case P4A-13
-- @title Nobody signed in proposes a site change
-- @category p4a_feeds
-- @expect error 42501 no signed-in actor
SELECT site_propose_change('{{SITE_TRI}}', '{"near_airport": true}'::jsonb, 'reason');
-- @end
