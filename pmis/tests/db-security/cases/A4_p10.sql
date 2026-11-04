-- Saved views and drafts (migration 0065, P10, owner answers Q115 and Q117). pmis_app only reads its own rows of saved_views,
-- saved_view_targets, saved_view_versions and user_drafts (row security) and writes them only through the sv_* and dr_* functions.
-- Another user's private view is never readable (not even by a System Admin), sharing needs views.share, versions are append-only and
-- a view is never deleted. Each case runs in a transaction that the runner rolls back.

-- @case SV-01
-- @title Alice inserts a saved view for herself directly (skipping the audited function)
-- @category saved-views
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO saved_views (owner_id, screen_key, name, created_by, updated_by) VALUES ('{{ALICE}}', 'sites', 'Direct', '{{ALICE}}', '{{ALICE}}');
-- @end

-- @case SV-02
-- @title Alice shares a view with everyone by writing the audience table directly
-- @category saved-views
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO saved_view_targets (view_id, target_kind, target_id) SELECT id, 'user', '{{BOB}}' FROM saved_views LIMIT 1;
-- @end

-- @case SV-03
-- @title Alice changes saved views directly (even her own)
-- @category saved-views
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE saved_views SET share_everyone = true;
-- @end

-- @case SV-04
-- @title Alice deletes the version history of saved views
-- @category saved-views
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM saved_view_versions;
-- @end

-- @case SV-05
-- @title Alice reads the System Admin's private view through sv_get
-- @category saved-views
-- @actor ADMIN
-- @region *
-- @expect error P0001 wf:not_found
SELECT (sv_save(NULL, NULL, '{"screen_key": "sites", "name": "Admin private", "filters": {"q": "secret"}}'::jsonb, NULL) ->> 'id') AS v \gset
\ctx ALICE
SELECT sv_get(:'v'::uuid);
-- @end

-- @case SV-06
-- @title Bob selects the saved_views table after the System Admin saved a private view (row security: own rows only)
-- @category saved-views
-- @actor ADMIN
-- @region *
-- @expect output 0
SELECT sv_save(NULL, NULL, '{"screen_key": "sites", "name": "Admin only"}'::jsonb, NULL) IS NOT NULL;
\ctx BOB
SELECT count(*) FROM saved_views;
-- @end

-- @case SV-07
-- @title Bob lists the views of the sites screen and gets the System Admin's private view
-- @category saved-views
-- @actor ADMIN
-- @region *
-- @expect output 0
SELECT sv_save(NULL, NULL, '{"screen_key": "sites", "name": "Admin listed"}'::jsonb, NULL) IS NOT NULL;
\ctx BOB
SELECT count(*) FROM jsonb_array_elements(sv_list('sites', 'all', true));
-- @end

-- @case SV-08
-- @title Alice, without views.share, shares a view with everyone
-- @category saved-views
-- @actor ALICE
-- @region 1
-- @expect error P0001 wf:action_forbidden
SELECT sv_save(NULL, NULL, '{"screen_key": "sites", "name": "To all", "audience": {"everyone": true}}'::jsonb, NULL);
-- @end

-- @case SV-09
-- @title Alice deactivates a view the System Admin shared with everyone
-- @category saved-views
-- @actor ADMIN
-- @region *
-- @expect error P0001 wf:(not_found|action_forbidden)
SELECT (sv_save(NULL, NULL, '{"screen_key": "sites", "name": "Shared by admin", "audience": {"everyone": true}}'::jsonb, NULL) ->> 'id') AS v \gset
\ctx ALICE
SELECT sv_set_active(:'v'::uuid, NULL, false, 'not mine');
-- @end

-- @case SV-10
-- @title Alice takes over the System Admin's shared view with sv_transfer
-- @category saved-views
-- @actor ADMIN
-- @region *
-- @expect error P0001 wf:(not_found|action_forbidden)
SELECT (sv_save(NULL, NULL, '{"screen_key": "sites", "name": "Take me", "audience": {"everyone": true}}'::jsonb, NULL) ->> 'id') AS v \gset
\ctx ALICE
SELECT sv_transfer(:'v'::uuid, NULL, '{{ALICE}}', 'mine now');
-- @end

-- @case SV-11
-- @title Alice writes an audit row for a view through the internal recorder
-- @category saved-views
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT sv_record(gen_random_uuid(), 'edit', NULL, 'forged');
-- @end

-- @case SV-12
-- @title Alice grants herself views.share in a permission profile
-- @category saved-views
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied|written only through
INSERT INTO permission_grants (profile_id, module_key, action) SELECT id, 'views', 'create' FROM permission_profiles LIMIT 1;
-- @end

-- @case SV-13
-- @title Alice reads the System Admin's draft through dr_get
-- @category saved-views
-- @actor ADMIN
-- @region *
-- @expect output none
SELECT dr_save('form.secret', '{"note": "admin draft"}'::jsonb, NULL) IS NOT NULL;
\ctx ALICE
SELECT coalesce(dr_get('form.secret')::text, 'none');
-- @end

-- @case SV-14
-- @title Alice writes a draft row for Bob directly
-- @category saved-views
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO user_drafts (user_id, draft_key, payload) VALUES ('{{BOB}}', 'form.x', '{}'::jsonb);
-- @end

-- @case SV-15
-- @title Bob discards the System Admin's draft (only his own key space is touched)
-- @category saved-views
-- @actor ADMIN
-- @region *
-- @expect output 1
SELECT dr_save('form.keep', '{"a": 1}'::jsonb, NULL) IS NOT NULL;
\ctx BOB
SELECT dr_discard('form.keep');
\ctx ADMIN
SELECT count(*) FROM jsonb_array_elements(dr_list()) d WHERE d ->> 'key' = 'form.keep';
-- @end
