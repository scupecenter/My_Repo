# Link conflict alert

Migration 0626 (mirror `db/sql/625_link_conflict_alert.sql`), API 0.15.485. Additive, notifications only.

- Rule kind `link_conflict` {register_key?, field_code?, min_rows 1..100000}. Weekly, per declared register link.
- `register_link_conflicts()` counts approved current rows whose linked target record is current and still open (state not approved and not voided). Definer function, no grant to the app role.
- Patched in place and idempotently: the kind list of `alert_rules`, `alert_rule_params_errs()`, `alert_rules_run()`.
- Choice: "closed" means approved, "open" means any state other than approved or voided. The link direction is the declared one (the record holding the link field is the closed one).
- Web: the same register, field and minimum-rows form as the orphans alert; Automation centre line; EN and AR.
