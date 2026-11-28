# Rule log and dry run

Migration 0627 (mirror `db/sql/626_rule_dry_run.sql`), API 0.15.486. Additive, read only for the data.

- `alert_rule_dry_run_json(rule)`: evaluates the rule as the daily run would today inside a sub-transaction that is always rolled back (the rule is switched on inside it, so an off rule can be previewed). Returns would_fire, notifications and up to 50 targets. Nothing is sent and no journal or audit row stays.
- `alert_rule_log_json(rule, limit)`: last runs and firings of one rule.
- Routes `GET /settings/alert-rules/{id}/dry-run` and `/log`, System Admin (admin.settings check inside the function).
- Choice: the whole run is evaluated and only the chosen rule's firings are reported, so the preview matches the real run exactly.
- Web: two buttons on each rule card of the Automation centre. EN and AR.
