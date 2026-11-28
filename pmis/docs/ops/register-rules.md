# Register rules (Settings > Data > Columns, section "Register rules")

The rules of a register live in `register_definitions.rules` and are read by the database. The screen edits the keys of `register_rule_catalogue()`: it checks the key and its type,
asks a reason, uses the ETag of the register and writes the audit record (`admin_register_rules`, migration 0430). Only a System Admin or a `fields.edit` delegate sees the screen.

## Editable keys (catalogue)
| Register | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| invoices | `currency` | text (up to 20) | LYD | currency of an invoice |
| invoices | `order_required` | yes/no | no | an invoice must name its Procurement order |
| invoices | `supplier_required` | yes/no | no | an invoice must name its supplier company |
| financial_advances | `currency` | text | LYD | currency of the advances (migration 0643) |
| financial_advances, car_dispatcher, daily_plan | `master_export` | yes/no | yes | the register is a sheet of the Master workbook. Changing it changes the Master template (its header checksum): download it again (migration 0643) |

## Read-only keys (`other`, migration 0643)
The screen lists every other key of a register, so nothing is hidden: the scope maps of Procurement and Permits (`scope_rows`, `refused_scopes`, `scope_from`), the scope of a team
register (`scope`, `scope_of`, `applies_to`), `field_work_scopes`, `master_exclude_fields`, the Daily Plan levels (`l1`, `l2`, `matrix_only`) and two keys that no code reads today
(`counts_as_purchase_request`, `purchase_request_in`). They are set by the system; to make one editable, add it to `register_rule_catalogue()` with its type and the check that reads it.
