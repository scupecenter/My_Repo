# Custom registers

Review item 11. An administrator creates a register without code and without a migration per register. It runs on the same register framework as every other register:
columns, sections, lists, templates, upload and download, approval in two levels, search, export, the Matrix row and the permission module.

## How an administrator uses it

1. Settings > Registers > **Custom registers** > New custom register. Give the English name (the key is made from it: `custom_` and letters, and it never changes), the Arabic
   name, whether each record belongs to a site and whether a site may have more than one record. The register starts **disabled**.
2. Add its columns on Settings > Registers > Columns (the **Columns** button of the row opens that screen on the new register). At least one column must be required and in the
   template: it identifies a record when a file is uploaded.
3. **Enable**. The register gets its upload and download template, its permission module (same key as the register) and the Matrix row. The side menu has one entry,
   **Custom registers**, that opens a hub listing the enabled registers the person may view.
4. Grant the module in the permission grid or the Matrix like any other module. Creating or enabling a register grants nothing to anyone.
5. **Hide** removes the register from the hub, the register list and the grid editor. Nothing is deleted: records, columns and grants stay, and **Show again** brings it back.

Create, enable, hide and show need a recent sign-in check (step-up) and a reason. Rename needs a reason. Only a System Admin, or an all-regions delegate of the custom fields, can use
the screen.

## Limit

`registers.custom_max` (Settings > Security > Limits, group Custom registers): how many custom registers may be active at once. Default 20, range 1 to 100. Hidden registers are not
counted. Lowering it never hides an existing register; it only stops new ones.

## Where it is stored

- Migration `0531_custom_registers` (mirror `db/sql/530_custom_registers.sql`): `register_definitions.is_custom`, `created_by`, `created_at`, and the doors `admin_register_create`,
  `admin_register_update`, `admin_register_enable`. No new table.
- `is_custom` is a flag, not a new `kind` value, so every place that filters by kind keeps working. A custom key must start with `custom_` and a built-in key must not.
- Data reset: the part `custom_registers` (the records of every custom register) is in `data_reset_parts()` and `data_reset_register_part()`.

## Not included

Typed projections, task sources, SLA rules, dashboard and KPI sources, links between registers, workflow versions, and a per-register column limit. A custom register uses the
generic approval workflow with two levels.
