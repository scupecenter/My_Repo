-- 0230_dash_ops_procurement (contract 0.15.98): the dashboard follow-up card "Procurement and materials" (owner approval 2026-11-26,
-- dashboard proposals item 1). Mirror: db/sql/229_dash_ops_procurement.sql (kept identical).
--
-- Additive: one card code, ops_procurement, is added to the dashboard settings catalogue (migration 0108), keeping the ops_scurve card of 0198, so the card can be shown,
-- hidden and ordered per tab in Settings > Dashboard like every other card. A card in the catalogue that no saved list names is shown
-- at the end, so the card appears by default. No table, no data, no grant, no permission and no threshold changes.

CREATE OR REPLACE FUNCTION dashboard_settings_catalogue() RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'kpis', '[
      {"code":"sla_breach","label_en":"SLA breaches (open tasks past the maximum)","label_ar":"تجاوزات SLA (مهام مفتوحة تجاوزت الحد الأقصى)","unit":"pct","direction":"lower","default_green":5,"default_amber":10},
      {"code":"sla_at_risk","label_en":"SLA at risk (past the warning share)","label_ar":"SLA معرّض للخطر (تجاوز نسبة الإنذار)","unit":"pct","direction":"lower","default_green":10,"default_amber":20},
      {"code":"data_quality_gap","label_en":"Empty mandatory cells","label_ar":"خلايا إلزامية فارغة","unit":"pct","direction":"lower","default_green":2,"default_amber":5},
      {"code":"vehicle_ready","label_en":"Vehicle-ready rate of assignments","label_ar":"نسبة جاهزية المركبة للمهام الميدانية","unit":"pct","direction":"higher","default_green":90,"default_amber":75},
      {"code":"advances_open_after_close","label_en":"Advances open after the work closed","label_ar":"سلفيات مفتوحة بعد إغلاق العمل","unit":"count","direction":"lower","default_green":0,"default_amber":3},
      {"code":"dismantle_pending","label_en":"Dismantle CW and TE pending","label_ar":"تفكيك CW وTE المعلّق","unit":"count","direction":"lower","default_green":0,"default_amber":5},
      {"code":"as_built_submitted","label_en":"As-Built submitted against PAC","label_ar":"As-Built المقدَّم مقابل PAC","unit":"pct","direction":"higher","default_green":90,"default_amber":70},
      {"code":"time_in_state_p85","label_en":"Time in state, 85th percentile","label_ar":"الزمن في الحالة، المئين 85","unit":"days","direction":"lower","default_green":10,"default_amber":20},
      {"code":"stale_tasks","label_en":"Stale tasks (idle for N working days)","label_ar":"مهام راكدة (خاملة لعدد من أيام العمل)","unit":"pct","direction":"lower","default_green":5,"default_amber":10},
      {"code":"on_air_vs_target","label_en":"On-Air against the monthly target","label_ar":"الربط On-Air مقابل الهدف الشهري","unit":"pct","direction":"higher","default_green":100,"default_amber":80}
    ]'::jsonb,
    'cards', '[
      {"code":"site_map","label_en":"Site map","label_ar":"خريطة المواقع"},
      {"code":"f13","label_en":"Risk matrix, data quality, decisions, swap and relocation","label_ar":"مصفوفة المخاطر وجودة البيانات والقرارات والاستبدال والنقل"},
      {"code":"headline","label_en":"Headline KPIs","label_ar":"المؤشرات الرئيسية"},
      {"code":"pipeline","label_en":"Milestone pipeline","label_ar":"مسار المعالم"},
      {"code":"health_ps","label_en":"Health index and Project Status","label_ar":"مؤشر الصحة وحالة المشروع"},
      {"code":"streams","label_en":"Streams","label_ar":"المسارات"},
      {"code":"sla","label_en":"SLA per stage and top late tasks","label_ar":"SLA لكل مرحلة وأهم المهام المتأخرة"},
      {"code":"gates_issues_delay","label_en":"Blocked gates, issues and delay attribution","label_ar":"البوابات المعطلة والقضايا وتوزيع التأخير"},
      {"code":"counters","label_en":"Counters: SLA breaches and at risk, data quality, KPI colours","label_ar":"العدادات: خروقات SLA والمعرضة للخطر وجودة البيانات وألوان المؤشرات"},
      {"code":"regions","label_en":"Regions","label_ar":"المناطق"},
      {"code":"ops_scurve","label_en":"Progress curve: planned vs actual, velocity and forecast","label_ar":"منحنى التقدم: المخطط مقابل الفعلي والسرعة والتوقع"},
      {"code":"ops_procurement","label_en":"Procurement and materials","label_ar":"المشتريات والمواد"}
    ]'::jsonb
  )
$$;
