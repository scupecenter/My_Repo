-- 0030_om_view_fixed: final owner decision on the O&M view (2026-11-01, Q102 final; replaces "D18 moves to O&M only after assignment"). Mirror: db/sql/029_om_view_fixed.sql (kept identical).
--
--   CW view : stages MS2-MS4 + CW DLP (B14) + CW FAC (B15). Unchanged.
--   TE view : stages MS5-MS9 (through TE PAC, KPI acceptance and HOTO). TE FAC (D18) is NOT in TE any more.
--   O&M view: ALWAYS everything after HOTO: TE FAC (D18, with the TE DLP end date) and Final Closure (Z1). Fixed membership (om_assigned NULL), independent of views.om_team_assigned.
-- Responsibility is not display: the matrix holders are unchanged. Before the O&M team is assigned the TE Team Lead acts on D18 from the O&M tab; after, O&M acts. Z1 stays with the Project Manager (B2).
-- om_assigned on view members is no longer used by the seed (all NULL); the column and the setting stay for the responsibility switch.

DELETE FROM workflow_view_members WHERE view_code = 'TE' AND member_kind = 'task' AND member_code = 'D18';

INSERT INTO workflow_view_members (workflow_id, view_code, member_kind, member_code, om_assigned)
SELECT w.id, 'OM', 'task', t.code, NULL FROM workflow_definitions w CROSS JOIN (VALUES ('D18'), ('Z1')) AS t(code)
ON CONFLICT (workflow_id, view_code, member_kind, member_code) DO UPDATE SET om_assigned = NULL;

UPDATE settings SET description = 'Whether the O&M team is assigned (Q102). One project-wide switch, default false (not assigned). It decides who acts on TE FAC (D18), not what is shown: false, the TE Team Lead acts on it from the O&M tab; true, the O&M team does. The O&M view always lists TE FAC (D18) and Final Closure (Z1); Z1 is always approved by the Project Manager.', updated_at = now()
WHERE key = 'views.om_team_assigned';
