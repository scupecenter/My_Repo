# Alert defaults and data-completeness reminder

Migration 0625 (mirror `db/sql/624_alert_defaults.sql`), API 0.15.484. Additive.

## What
- New alert rule kind `data_gaps` with `min_sites` (1..100000, default 1). Weekly, per region: counts active sites with a null delivery scenario or a missing actual date where a later task is done; notifies the module audience of the rule through `alert_rule_notify`, once per week and region.
- `alert_rules_seed_defaults()` runs before the rule loop of `alert_rules_run`. It inserts only codes that are absent, authored by the oldest active System Admin (skipped if none): `idle-<register>` rules (entry state, 14 days, audience the register's module) for enabled, active main registers, and `data-completeness-weekly`.

## Choices
- Main registers: acquisition, procurement, change_control, issues, risks, rf_design, permits, gecol, hlc.
- Defaults are normal rules; an admin edit or switch-off is kept because existing codes are never touched.
- No grant, role or permission change; notifications only.

## Surface
Settings, alert rules: new kind form field (minimum sites), catalogue entry and template. Automation centre shows the "when" line for the kind. EN and AR.
