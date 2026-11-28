-- 0554_daily_delay: the daily delay log. A "Daily delay" is a type (a value of the list IssueCategory) of the Issues register: the site it hit (the record's site), the day
-- (new optional field delay_date), the reason (the existing list BlockerReason, edited in Settings > Registers > Lists: add, rename, merge, hide, never delete) and, when it
-- stopped one task, that task (the existing field blocked_gate_or_task). Mirror: db/sql/553_daily_delay.sql (kept identical to prisma/migrations/0554_daily_delay/migration.sql).
--
-- Nothing is rebuilt: the register, its rights, search, filters, saved views, export, audit of every save, the data reset plan and the dashboard breakdown (by_category and by_reason of
-- dash_sec_issues) already read the register fields, so a delay shows in all of them with no code change. Additive and idempotent: a second run changes nothing.
--   1. IssueCategory gets the value "Daily Delay" (EN/AR); a value already hidden by the owner stays hidden.
--   2. BlockerReason gets "Weather", "Permit Pending", "Delivery Delay" and "Safety Stop" only when no value of that code exists (the older "Weather or Security" and
--      "Access or Permit" stay).
--   3. The Issues register gets the optional field delay_date (date, shown in the list and the filters). Nothing becomes required.

SELECT set_config('app.region_ids', '*', true);

INSERT INTO list_values (catalogue_code, code, label_en, label_ar, sort_order) VALUES
  ('IssueCategory', 'Daily Delay',    'Daily delay',    'تأخير يومي',  15),
  ('BlockerReason', 'Weather',        'Weather',        'الطقس',        120),
  ('BlockerReason', 'Permit Pending', 'Permit pending', 'تصريح معلّق',  130),
  ('BlockerReason', 'Delivery Delay', 'Delivery delay', 'تأخر التسليم', 140),
  ('BlockerReason', 'Safety Stop',    'Safety stop',    'إيقاف للسلامة', 150)
ON CONFLICT (catalogue_code, code) DO NOTHING;

INSERT INTO register_fields (register_key, code, label_en, label_ar, field_type, required, is_actual, derived, options, in_list, section, sort_order, list_catalogue) VALUES
  ('issues', 'delay_date', 'Delay date', 'تاريخ التأخير', 'date', false, false, false, NULL, true, 'Issue', 17, NULL)
ON CONFLICT (register_key, code) DO NOTHING;
