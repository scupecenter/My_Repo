-- Region health card (contract 0.15.241; CHANGELOG RegionHealth; owner request 2026-11-27, item 12 of the PM-platforms research).
--
-- One new dashboard card, region_health: the current-week health of every region of the Weekly status (on track, at risk, off track) with the
-- "missing update" flag when no region update was posted this week. Additive: the catalogue gains the card, and a card no tab layout names is shown
-- at the end by default (migration 0108), so existing layouts do not change. The data is read by GET /status-updates/region-health (no table, no
-- permission change: the same Sites regions scope as the Weekly status list).


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
      {"code":"region_health","label_en":"Region health","label_ar":"صحة المناطق"}
    ]'::jsonb
  )
$$;
