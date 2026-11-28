# Spec: assignment rules (0.15.481, migration 0622)

Goal: when a level opens to any one holder and nobody is named, pick the person by rule, for example region X to person Y.

Choices:
- Not an engine. The earlier plan (2026-11-07-assignments-fleet-advances.md) dropped a routing engine. A rule here only chooses among people the matrix already allows (wf_eligible, reg_eligible), so it never widens access.
- Reuses the automation centre (0.15.473) as the place to manage it, and the existing ball-in-court pin as the result.
- Specificity: region 4, key 2, level kind 1; ties go to the older rule.
- Applies only to the rule any one with no named person. All-members levels are untouched.
- Hide, never delete. System Admin only. Audit assign_rule_create, assign_rule_update, assign_rule_remove.
- Stacked on the automation centre PR (migration 0612); merge that first.
