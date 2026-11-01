-- 0024_view_members_fac_dlp: owner correction of the CW / TE / O&M views (2026-11-01, Q102 answered). Mirror: db/sql/023_view_members_fac_dlp.sql (kept identical).
--
--   CW view : stages MS2-MS4 + CW DLP (B14) and CW FAC (B15), ALWAYS (om_assigned NULL). CW DLP and CW FAC never concern O&M.
--   TE view : stages MS5-MS9 + TE FAC (D18) while the O&M team is not assigned (false).
--   O&M view: ONLY TE FAC (D18), once the O&M team is assigned (true).
-- The setting views.om_team_assigned is one project-wide switch (default false, not assigned); only D18 moves with it. Its screen comes later with Settings.
-- Applies to every workflow version (the members are versioned with the workflow, 0023).

INSERT INTO workflow_view_members (workflow_id, view_code, member_kind, member_code, om_assigned)
SELECT w.id, 'CW', 'task', 'B14', NULL FROM workflow_definitions w
ON CONFLICT (workflow_id, view_code, member_kind, member_code) DO UPDATE SET om_assigned = NULL;

UPDATE workflow_view_members SET om_assigned = NULL WHERE view_code = 'CW' AND member_kind = 'task' AND member_code = 'B15';
DELETE FROM workflow_view_members WHERE view_code = 'OM' AND member_kind = 'task' AND member_code IN ('B14', 'B15');

UPDATE settings SET description = 'Whether the O&M team is assigned (Q102). One project-wide switch, default false (not assigned). false: TE FAC (D18) shows in the TE view. true: it shows in the O&M view instead. CW DLP (B14) and CW FAC (B15) are always in the CW view and never in O&M.', updated_at = now()
WHERE key = 'views.om_team_assigned';
