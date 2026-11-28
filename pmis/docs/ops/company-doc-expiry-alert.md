# Company document expiry alert

Company documents and certificates carry an expiry date and a document type with lead days (Settings, Company documents). The built-in daily notice already tells the contractor coordinators. The alert rule kind `company_doc_expiry` (Settings, Security, Alerts) adds a rule of your own: your audience and your wording.

- Fires weekly for every active document of an active company that has expired or expires within the lead days of its type. Documents without an expiry date are never checked.
- Audience: system admin or the holders of the rule's module (use `contractors`). Company documents are central, so there is no region filter.
- Placeholders: `{{company}}`, `{{type}}`, `{{date}}` (the expiry date), `{{days}}` (days left, negative when expired).
- In-app only, nothing public. The rule never blocks an order or an assignment and changes no record.
- Stored in the existing alert rule tables: no new table, nothing added to the data reset plan.
- The daily job `alert_rules_run` evaluates it, once per document and week (`alert_rule_fires`).
