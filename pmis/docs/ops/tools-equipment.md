# Tools & Equipment register (C4, contract 0.15.457, migration 0597)

A site-scoped register of the project's tools and equipment: who holds each one (custodian, a user field) and when its calibration or inspection is next due.

- Key and module: `tools_equipment`. Two approval levels, several records per site. Fields in sections Equipment, Custody, Calibration and inspection, Remark.
- Lists: EquipmentCategory, EquipmentStatus, EquipmentDueKind (editable in Lists).
- Template: TPL-TOOLS-EQUIPMENT (match keys site and equipment number).
- Permissions: the Matrix row is empty in the seed. The admin names the holders; no grant is seeded.
- Expiry radar: `next_due_date` is added to the setting `expiry.radar` (30, 14, 7 days) when the register has no entry. Edit it in Settings.
- Data reset: one part (`tools_equipment`) in `data_reset_parts()`.
- Not included: a side-menu entry (nav files untouched), per-record links (register links are not on main), a date-approaching alert kind (not on main).
