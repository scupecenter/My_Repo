# Low-stock alert

A warehouse item gets a reorder level on the Warehouse Reorder tab (`PUT /warehouse/reorder-limits/{id}`, System Admin or the warehouse items edit grant, audited with a reason). The alert rule kind `stock_below_reorder` (Settings > Security > Alerts) turns that level into a notification.

- Fires weekly for every active item whose available stock is at or under its level. Items without a level are never checked.
- Audience: system admin or the holders of the rule's module (use `warehouse`). Stock is central, so there is no region filter.
- Placeholders: `{{item}}`, `{{available}}`, `{{level}}`, `{{qty}}` (the reorder quantity, empty when not set).
- In-app only, nothing public. The rule never changes stock or a record.
- Stored in the existing alert rule tables: no new table, nothing added to the data reset plan.
- The daily job `alert_rules_run` evaluates it, once per item and week (`alert_rule_fires`).
