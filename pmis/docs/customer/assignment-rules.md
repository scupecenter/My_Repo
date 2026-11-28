# Assignment rules

Settings > Alerts > Automation, section "Assignment rules" (System Admin only). A rule says who takes a step when it opens to any one of its holders and nobody is named.

- A rule has: applies to (tasks or register records), a region (or any), a task code or register key (or any), a step kind (entry, review, approval, or any) and a person.
- The most specific rule wins: region first, then task or register, then step kind. Among equals, the older rule wins.
- A rule never adds a holder. The person must already be allowed for that step by the Responsibility Matrix, the grants and the region. If not, the rule is skipped and the step stays open to its holders as before.
- Steps that open to all members are not touched.
- When a rule picks someone, that person is named as holding the ball and is notified, the same as an assignment by hand.
- Switch a rule off to pause it. Remove hides it. Nothing is deleted. Each change is in the Audit Log (`assign_rule_create`, `assign_rule_update`, `assign_rule_remove`).
- No role, grant or permission changes.
