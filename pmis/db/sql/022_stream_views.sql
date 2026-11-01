-- 0023_stream_views: the CW / TE / O&M views of the Site Register (owner decision 2026-10-31, Q98 answered 2026-11-01).
-- Mirror: db/sql/022_stream_views.sql (kept identical).
--
-- The four seed streams stay the filter (0015). A view is a second, task-level grouping shown as a tab: it is seed data, admin-configurable and
-- versioned with the workflow definition, like a stream. Membership is by stage code or task code of the workflow version.
--   CW   : stages MS2-MS4 (after Site Release, to Site RFI, with the CW PAC B13) + CW FAC (B15) while the O&M team is not assigned.
--   TE   : stages MS5-MS9 (after Site RFI, to HOTO, with stage 8 KPI: F1, F2, MS8; HOTO: D17, MS9) + TE FAC (D18) while the O&M team is not assigned.
--   O&M  : CW DLP (B14) always; CW FAC (B15) and TE FAC (D18) once the O&M team is assigned.
-- Stage 1 (MS1) and Final Closure (Z1, MS10) are in no view: they show only in the all-work view. Dismantle (E1-E3) is its own register.
-- om_assigned on a member: NULL = always, false = only while the O&M team is not assigned, true = only after the assignment. The switch is the
-- setting views.om_team_assigned. The spec has no data for it (open question Q102), so the default is false (not assigned): FAC stays with the stream holders (Q40).

CREATE TABLE workflow_views (
  workflow_id UUID    NOT NULL REFERENCES workflow_definitions (id) ON DELETE CASCADE ON UPDATE CASCADE,
  code        TEXT    NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{1,30}$'),
  name_en     TEXT    NOT NULL,
  name_ar     TEXT,
  sort_order  INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, code)
);
CREATE UNIQUE INDEX workflow_views_workflow_id_sort_order_key ON workflow_views (workflow_id, sort_order);

CREATE TABLE workflow_view_members (
  workflow_id UUID    NOT NULL,
  view_code   TEXT    NOT NULL,
  member_kind TEXT    NOT NULL CHECK (member_kind IN ('stage', 'task')),
  member_code TEXT    NOT NULL,
  om_assigned BOOLEAN,
  PRIMARY KEY (workflow_id, view_code, member_kind, member_code),
  FOREIGN KEY (workflow_id, view_code) REFERENCES workflow_views (workflow_id, code) ON DELETE CASCADE ON UPDATE CASCADE
);

-- A new draft version starts with the views and members of the previous version (admin_create_workflow_draft knows nothing of views).
CREATE OR REPLACE FUNCTION workflow_views_inherit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE prev uuid;
BEGIN
  SELECT w.id INTO prev FROM public.workflow_definitions w WHERE w.version < NEW.version ORDER BY w.version DESC LIMIT 1;
  INSERT INTO public.workflow_views (workflow_id, code, name_en, name_ar, sort_order)
    SELECT NEW.id, v.code, v.name_en, v.name_ar, v.sort_order FROM public.workflow_views v WHERE v.workflow_id = prev;
  INSERT INTO public.workflow_view_members (workflow_id, view_code, member_kind, member_code, om_assigned)
    SELECT NEW.id, m.view_code, m.member_kind, m.member_code, m.om_assigned FROM public.workflow_view_members m WHERE m.workflow_id = prev;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_views_inherit AFTER INSERT ON workflow_definitions FOR EACH ROW EXECUTE FUNCTION workflow_views_inherit();

-- Configuration tables: everyone reads, writes need workflow_versions rights (same as workflow_streams, 0015).
ALTER TABLE workflow_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_views FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON workflow_views FOR SELECT USING (true);
CREATE POLICY rls_insert ON workflow_views FOR INSERT WITH CHECK (app_can('workflow_versions', 'create') OR app_is_seeding());
CREATE POLICY rls_update ON workflow_views FOR UPDATE USING (app_can('workflow_versions', 'edit') OR app_is_seeding()) WITH CHECK (app_can('workflow_versions', 'edit') OR app_is_seeding());
CREATE POLICY rls_delete ON workflow_views FOR DELETE USING (app_can('workflow_versions', 'delete') OR app_is_seeding());
ALTER TABLE workflow_view_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_view_members FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON workflow_view_members FOR SELECT USING (true);
CREATE POLICY rls_insert ON workflow_view_members FOR INSERT WITH CHECK (app_can('workflow_versions', 'create') OR app_is_seeding());
CREATE POLICY rls_update ON workflow_view_members FOR UPDATE USING (app_can('workflow_versions', 'edit') OR app_is_seeding()) WITH CHECK (app_can('workflow_versions', 'edit') OR app_is_seeding());
CREATE POLICY rls_delete ON workflow_view_members FOR DELETE USING (app_can('workflow_versions', 'delete') OR app_is_seeding());

GRANT SELECT, INSERT, UPDATE, DELETE ON workflow_views, workflow_view_members TO pmis_definer;
ALTER FUNCTION workflow_views_inherit() OWNER TO pmis_definer;
REVOKE ALL ON FUNCTION workflow_views_inherit() FROM PUBLIC;

-- Seed: the three views and their members for every existing version. Arabic names are proposals.
INSERT INTO workflow_views (workflow_id, code, name_en, name_ar, sort_order)
SELECT w.id, v.code, v.name_en, v.name_ar, v.sort_order
FROM workflow_definitions w
CROSS JOIN (VALUES
  ('CW', 'CW Register',  'سجل الأعمال المدنية',   1),
  ('TE', 'TE Register',  'سجل التركيبات',          2),
  ('OM', 'O&M',          'التشغيل والصيانة',       3)
) AS v(code, name_en, name_ar, sort_order);

INSERT INTO workflow_view_members (workflow_id, view_code, member_kind, member_code, om_assigned)
SELECT w.id, m.view_code, m.member_kind, m.member_code, m.om_assigned
FROM workflow_definitions w
CROSS JOIN (VALUES
  ('CW', 'stage', 'MS2', NULL::boolean), ('CW', 'stage', 'MS3', NULL), ('CW', 'stage', 'MS4', NULL), ('CW', 'task', 'B15', false),
  ('TE', 'stage', 'MS5', NULL), ('TE', 'stage', 'MS6', NULL), ('TE', 'stage', 'MS7', NULL), ('TE', 'stage', 'MS8', NULL), ('TE', 'stage', 'MS9', NULL),
  ('TE', 'task', 'D18', false),
  ('OM', 'task', 'B14', NULL), ('OM', 'task', 'B15', true), ('OM', 'task', 'D18', true)
) AS m(view_code, member_kind, member_code, om_assigned);

INSERT INTO settings (key, value, description, updated_at) VALUES
  ('views.om_team_assigned', 'false', 'Whether the O&M team is assigned (Q102). false: CW FAC (B15) shows in the CW view and TE FAC (D18) in the TE view, with the stream holders. true: both show in the O&M view instead. Default false.', now())
ON CONFLICT (key) DO NOTHING;
