-- Phase 4b, X1 to X7 (migrations 0031 and 0040). The application role never writes notifications, follows or status updates itself: rows are created only by the
-- definer functions (wf_notify, reg_notify, x_notify_watchers, x_follow, x_status_post, x_status_edit), a person reads and changes only their own notification
-- (read_at and snoozed_until, nothing else), and the helper functions that decide who is notified are not callable from the application role.
-- Alice has no assignment here, so she holds no right on any module or region; Bob owns one follow and one notification; the status update is for Benghazi.

-- @case XF-01
-- @title Alice inserts a follow for herself directly (a follow written outside x_follow)
-- @category x-features
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO watches (user_id, entity_type, entity_id, site_id, region_id) VALUES ('{{ALICE}}', 'site', '{{SITE_TRI}}', '{{SITE_TRI}}', 1);
-- @end

-- @case XF-02
-- @title Alice deletes the follows of other people
-- @category x-features
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM watches;
-- @end

-- @case XF-03
-- @title Alice moves Bob's follow to herself
-- @category x-features
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE watches SET user_id = '{{ALICE}}';
-- @end

-- @case XF-04
-- @title Alice reads Bob's follows (the row-level wall shows only her own)
-- @category x-features
-- @actor ALICE
-- @region 1
-- @expect output 0
SELECT count(*) FROM watches WHERE user_id = '{{BOB}}';
-- @end

-- @case XF-05
-- @title Alice forges a notification for Bob
-- @category x-features
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO notifications (user_id, channel, kind, title) VALUES ('{{BOB}}', 'in_app', 'system', 'Click here');
-- @end

-- @case XF-06
-- @title Alice rewrites the title of her own notification (only read_at and snoozed_until are hers to change)
-- @category x-features
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE notifications SET title = 'Edited' WHERE user_id = '{{ALICE}}';
-- @end

-- @case XF-07
-- @title Alice re-points her own notification to another person
-- @category x-features
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE notifications SET user_id = '{{BOB}}' WHERE user_id = '{{ALICE}}';
-- @end

-- @case XF-08
-- @title Alice marks Bob's notification as read (the row-level wall hides it: no row changes)
-- @category x-features
-- @actor ALICE
-- @region 1
-- @expect output 0
WITH u AS (UPDATE notifications SET read_at = now() WHERE user_id = '{{BOB}}' RETURNING 1) SELECT count(*) FROM u;
-- @end

-- @case XF-09
-- @title Alice reads Bob's notifications
-- @category x-features
-- @actor ALICE
-- @region 1
-- @expect output 0
SELECT count(*) FROM notifications WHERE user_id = '{{BOB}}';
-- @end

-- @case XF-10
-- @title Alice deletes notifications
-- @category x-features
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM notifications WHERE user_id = '{{ALICE}}';
-- @end

-- @case XF-11
-- @title Alice writes a status update directly
-- @category x-features
-- @actor ALICE
-- @region 5
-- @expect error 42501 permission denied
INSERT INTO status_updates (scope, region_id, week_start, health, summary, author_id) VALUES ('region', 5, date '2026-01-04', 'on_track', 'Forged', '{{ALICE}}');
-- @end

-- @case XF-12
-- @title Alice edits the status update of Benghazi directly
-- @category x-features
-- @actor ALICE
-- @region 5
-- @expect error 42501 permission denied
UPDATE status_updates SET summary = 'Edited' WHERE id = '{{XF_UPDATE}}';
-- @end

-- @case XF-13
-- @title Alice deletes status updates (they are never removed)
-- @category x-features
-- @actor ALICE
-- @region 5
-- @expect error 42501 permission denied
DELETE FROM status_updates;
-- @end

-- @case XF-14
-- @title A Tripoli session reads the status update of Benghazi (row-level security by region)
-- @category x-features
-- @actor ALICE
-- @region 1
-- @expect output 0
SELECT count(*) FROM status_updates WHERE id = '{{XF_UPDATE}}';
-- @end

-- @case XF-15
-- @title Alice, who is no lead, posts a status update through the function
-- @category x-features
-- @actor ALICE
-- @region 5
-- @expect error P0001 action_forbidden
SELECT x_status_post('region', 5, NULL, 'on_track', 'Not a lead');
-- @end

-- @case XF-16
-- @title Alice edits the status update of Benghazi through the function (she cannot see it: not found, not forbidden)
-- @category x-features
-- @actor ALICE
-- @region 1
-- @expect error P0001 not_found
SELECT x_status_edit('{{XF_UPDATE}}', 1, 'at_risk', NULL);
-- @end

-- @case XF-17
-- @title Alice follows a site although she holds no right on Sites (the answer is the one for a site that does not exist)
-- @category x-features
-- @actor ALICE
-- @region 1
-- @expect error P0001 not_found
SELECT x_follow('site', '{{SITE_TRI}}', NULL);
-- @end

-- @case XF-18
-- @title Alice follows a site of another region
-- @category x-features
-- @actor ALICE
-- @region 5
-- @expect error P0001 not_found
SELECT x_follow('site', '{{SITE_BEN}}', NULL);
-- @end

-- @case XF-19
-- @title Anonymous session follows a site (no signed-in actor)
-- @category x-features
-- @expect error 42501 no signed-in actor
SELECT x_follow('site', '{{SITE_TRI}}', NULL);
-- @end

-- @case XF-20
-- @title Anonymous session stops a follow (no signed-in actor)
-- @category x-features
-- @expect error 42501 no signed-in actor
SELECT x_unfollow('site', '{{SITE_TRI}}', NULL);
-- @end

-- @case XF-21
-- @title Alice follows something that is neither a site nor a register record
-- @category x-features
-- @actor ALICE
-- @region 1
-- @expect error P0001 validation_failed
SELECT x_follow('task', '{{SITE_TRI}}', NULL);
-- @end

-- @case XF-22
-- @title Alice stops Bob's follow (the delete is limited to her own: Bob's follow stays)
-- @category x-features
-- @actor ALICE
-- @region 1
-- @expect output f
SELECT x_unfollow('site', '{{SITE_TRI}}', NULL);
-- @end

-- @case XF-23
-- @title Alice calls the follower notification function to send a notification to anyone she likes
-- @category x-features
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT x_notify_watchers('{{SITE_TRI}}', NULL, NULL, 'Phishing', 'Click here', '/x', NULL, 1, 'sites');
-- @end

-- @case XF-24
-- @title Alice asks whether Bob can read a module (the helper that decides who is mentioned is not hers to call)
-- @category x-features
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT x_user_can_read('{{BOB}}', 'sites', 1);
-- @end

-- @case XF-25
-- @title Alice writes an audit row of a task and so notifies its followers (wf_audit is the engine's)
-- @category x-features
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT wf_audit('task_approve', '{{SITE_TRI}}', NULL, NULL, NULL);
-- @end

-- @case XF-26
-- @title Alice comments on a register record she cannot read, and names Bob (not found, nothing written)
-- @category x-features
-- @actor ALICE
-- @region 1
-- @expect error P0001 not_found
SELECT reg_add_comment('procurement', '00000000-0000-4000-8000-0000000000ff', 'Hello @1002', ARRAY['{{BOB}}']::uuid[]);
-- @end

-- @case XF-27
-- @title Alice comments on a task that does not exist (not found), naming Bob
-- @category x-features
-- @actor ALICE
-- @region 1
-- @expect error P0001 not_found
SELECT wf_add_comment('00000000-0000-4000-8000-0000000000fe', 'Hello', ARRAY['{{BOB}}']::uuid[]);
-- @end

-- @case XF-28
-- @title The notification trigger function is not callable as a function
-- @category x-features
-- @actor ALICE
-- @region 1
-- @expect error 0A000|42501 trigger functions can only be called as triggers|permission denied
SELECT x_notification_scope();
-- @end

-- Positive controls for the same objects: the legitimate paths let the harness through, so the refusals above are real.

-- @case XF-P1
-- @title Bob reads his own follow
-- @category x-features
-- @actor BOB
-- @region 1
-- @expect output 1
SELECT count(*) FROM watches WHERE user_id = '{{BOB}}';
-- @end

-- @case XF-P2
-- @title Bob reads his own notification and marks it read, snoozing it too
-- @category x-features
-- @actor BOB
-- @region 1
-- @expect output 1
WITH u AS (UPDATE notifications SET read_at = now(), snoozed_until = now() + interval '1 day' WHERE user_id = '{{BOB}}' RETURNING 1) SELECT count(*) FROM u;
-- @end

-- @case XF-P3
-- @title The System Admin follows a site of any region through x_follow
-- @category x-features
-- @actor ADMIN
-- @region *
-- @expect output site
SELECT x_follow('site', '{{SITE_BEN}}', NULL) ->> 'entity_type';
-- @end

-- @case XF-P4
-- @title The System Admin writes the status update of a region, and reads the one of Benghazi
-- @category x-features
-- @actor ADMIN
-- @region *
-- @expect output t
SELECT x_status_post('region', 5, NULL, 'at_risk', 'Synthetic control') IS NOT NULL AND (SELECT count(*) FROM status_updates WHERE id = '{{XF_UPDATE}}') = 1;
-- @end
