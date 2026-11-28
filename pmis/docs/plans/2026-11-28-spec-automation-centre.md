# Automation centre (over the alert rules)

Choices recorded here:

- No second rule engine. The centre reads and creates alert rules (0.15.242 and later). The action is a notification only.
- Templates are a closed list served in the catalogue of `GET /settings/alert-rules`. A template fills the existing create call (same checks, reason and audit row), so no new write path exists.
- Runs: new LOG table `alert_rule_runs` (migration 0614) filled by `alert_rules_runs_record()` in the daily job transaction. A run that fired writes one audit row `alert_rule_run` with no actor, via job, job_name `alert_rules`. A run that found nothing is recorded at most once per 12 hours.
- `GET /settings/alert-rules/runs` lists the last 50 runs for a System Admin.
- Screen: Settings > Alerts > Automation, admin only. Rules show as cards "When / Then", with the last run. Rule editing stays in Manage rules.
- No rights, grants or kinds changed.
