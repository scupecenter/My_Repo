-- 0541: calibrated Project Status weight set, created as a DRAFT (never published by this migration).
--
-- Calibration of the v1 activity weights against published telecom-rollout weighting practice
-- (milestone weighting ranges, e.g. Acquisition ~5, Civil 15-20, Installation ~20,
-- Integration/Optimization 15-25, Handover 10-20) and PMI EVM guidance that weights should
-- reflect effort/cost share, not just milestone count:
--   A1 Survey & Engineering         12       (unchanged)
--   A2 Site Acquisition & Permits    8       (unchanged)
--   A3 Procurement & Supply          5       (unchanged)
--   A4 Civil Work & Site Readiness  25 -> 20  (industry civil 15-20; v1's 25 over-weights civil)
--   A5 TE Installation              20       (unchanged)
--   A6 Integration & On-Air         12 -> 15
--   A7 Testing & Acceptance         13 -> 15  (covers the industry "optimization" share; v1 has no optimization phase)
--   A8 Training & Handover           5       (unchanged)
-- Item weights inside each activity are percentages of the activity and are copied from v1
-- unchanged; the calibration is entirely at the activity level. The set stays a draft:
-- activation goes through the existing admin review/publish flow, which sets its own
-- effective dates. Published v1 and all snapshots are untouched.
DO $$
DECLARE ws uuid; nil constant uuid := '00000000-0000-0000-0000-000000000000';
BEGIN
  IF EXISTS (SELECT 1 FROM weight_sets WHERE code = 'project_status' AND version = 2) THEN RETURN; END IF;
  INSERT INTO weight_sets (code, version, effective_from, status, reason, changed_by)
  VALUES ('project_status', 2, DATE '2099-01-01', 'draft',
          'calibration vs industry weighting ranges (PMI EVM / telecom milestone practice); DRAFT - publish through the admin flow, which sets real effective dates',
          nil)
  RETURNING id INTO ws;
  INSERT INTO weight_activities (weight_set_id, code, name, name_ar, weight, sort) VALUES
    (ws, 'A1', 'Survey & Engineering',        'المسح والهندسة',            12, 10),
    (ws, 'A2', 'Site Acquisition & Permits',  'استحواذ الموقع والتصاريح',  8,  20),
    (ws, 'A3', 'Procurement & Supply',        'المشتريات والتوريد',        5,  30),
    (ws, 'A4', 'Civil Work & Site Readiness', 'الأعمال المدنية وجاهزية الموقع', 20, 40),
    (ws, 'A5', 'TE Installation',             'تركيب TE',                  20, 50),
    (ws, 'A6', 'Integration & On-Air',        'التكامل والتشغيل',          15, 60),
    (ws, 'A7', 'Testing & Acceptance',        'الاختبار والقبول',          15, 70),
    (ws, 'A8', 'Training & Handover',         'التدريب والتسليم',          5, 80);
  INSERT INTO weight_items (activity_id, code, name, name_ar, weight, unit, measure_rule, source, sort)
  SELECT na.id, i.code, i.name, i.name_ar, i.weight, i.unit, i.measure_rule, i.source, i.sort
  FROM weight_items i
  JOIN weight_activities oa ON oa.id = i.activity_id
  JOIN weight_sets os ON os.id = oa.weight_set_id AND os.code = 'project_status' AND os.version = 1
  JOIN weight_activities na ON na.weight_set_id = ws AND na.code = oa.code;
  IF (SELECT count(*) FROM weight_items i JOIN weight_activities a ON a.id = i.activity_id WHERE a.weight_set_id = ws)
     <> (SELECT count(*) FROM weight_items i JOIN weight_activities a ON a.id = i.activity_id JOIN weight_sets s ON s.id = a.weight_set_id WHERE s.code = 'project_status' AND s.version = 1) THEN
    RAISE EXCEPTION 'calibrated set item count mismatch';
  END IF;
END $$;
