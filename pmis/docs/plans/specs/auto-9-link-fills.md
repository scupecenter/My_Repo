# Automation 9: final approval fills the linked record (Telecom Site Delivery Workspace)

Reuses the register links of D60 (`register_links`, 0409/0410, Settings > Register links). Adds one settings table and one trigger (migration 0772, contract 0.15.648).

- `register_link_fills`: one row per (register, link field, target field) with the source field of the approved record. Seeded empty, edited in Settings > Registers > "Fill linked records on approval" with a reason and audit (GET and PUT `/settings/link-fills`, If-Match). A row is hidden with `is_active`, never deleted. The save checks that the link is declared, both fields exist in their registers and have the same type.
- Trigger `reg_link_fills_apply` (AFTER UPDATE OF state): when a current record becomes approved, every active row copies the value into the record the link field points to. Safe by construction: the target must be current and still in entry (an approved record is never touched), the target field must be empty (a typed value is never overwritten), the source value must be non-empty, and each fill is audited as `register_link_fill`.
- Typical use once the owner adds rules: an approved invoice fills the delivery or invoice-number field of its order; an approved delivery note fills the delivery date.
- `data_reset_plan()` lists the table as KEEP (config), patched in place; `pmis_reset_owner` has its grants.

Not covered on purpose: no import/export template (a short list of rules, edited in Settings); no fill into an approved record (it would need a new version, which is the approval path); no seeded rule. Manual entry stays possible: a person can still type the field before the approval, and it is never overwritten. No AI features.
