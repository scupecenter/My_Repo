-- 0780_risk_score (A2): the risk score and level. A risk has a probability and an impact (each 1 to 5); the score is probability x impact (1 to 25) and the level is the band of the
-- existing 5x5 risk matrix (low 1-4, medium 5-9, high 10-16, critical 20-25; the same bands the dashboard risk matrix uses). Both are DERIVED: the API computes them on read from the
-- two typed values, nothing is stored, nothing can be typed (field_read_only), no permission or default changes. Mirror: db/sql/779_risk_score.sql (identical to this file).
--
-- The Risks register gets two read-only fields so the list, the record view, the filters of the columns menu and the column settings show them like every other field:
--   risk_score (number) and risk_level (text holding the band code low, medium, high or critical; the screens show it translated).
-- Additive and idempotent: a second run changes nothing.

SELECT set_config('app.region_ids', '*', true);

INSERT INTO register_fields (register_key, code, label_en, label_ar, field_type, required, is_actual, derived, options, in_list, section, sort_order, list_catalogue) VALUES
  ('risks', 'risk_score', 'Risk score', 'درجة المخاطرة', 'number', false, false, true, NULL, true, 'Assessment', 75, NULL),
  ('risks', 'risk_level', 'Risk level', 'مستوى المخاطرة', 'text',   false, false, true, NULL, true, 'Assessment', 76, NULL)
ON CONFLICT (register_key, code) DO NOTHING;
