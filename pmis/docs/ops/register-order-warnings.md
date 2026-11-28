# Order warnings and counts for every register (M1, contract 0.15.464, migration 0604)

## What it does
The reviewer warning of Q151 (a later date before an earlier one in a chain, never blocking) was only for GECOL. It now works for every register that has date
columns, set in **Settings > Registers > Order warnings** (pick the register, build the chains, save with a reason). Off everywhere until an administrator turns it on.

## How it works
- `reg_order_warnings(register, data)` is the one chain walk. `gecol_order_warnings(data)` is a one-line wrapper over it, so GECOL output (`gecol_order`, paths, messages) is unchanged.
- GECOL keeps its setting key `gecol.order_warnings` (and its routes `/settings/gecol-order-warnings`). Every other register keeps `{enabled, chains, billing_after, billing_field, version}` under `register.order_warnings` -> `registers` -> `<key>`. Nothing is seeded.
- The reviewer warnings (`reg_warnings_p4c`) call `reg_order_warnings` for every register but GECOL. Warning code `order`; `billing_before_event` for the billing check.
- Fields offered: the active **date** columns of the register, custom columns added later included. A status or list column has no date to compare, so it is not part of a chain.
- The billing check is optional: choose the event date and the billing date; the billing date must not be before the event. Give both or neither. For GECOL the billing date is always the billing conversion date.
- Writer: `admin_save_register_order_warnings(register, config, reason, version)`: System Admin or a delegation of `admin.settings` edit for all regions, a reason, If-Match per register, audit action `register_order_warnings_update` with before and after. GECOL goes through `admin_save_gecol_order_warnings` (audit action unchanged).
- API: `GET/PUT /settings/registers/{key}/order-warnings`, `GET /settings/register-counts`.

## Connections
- Registers: the warning list in the record drawer and the badge on the list. The data upload does not run these warnings (import validation does not call `reg_warnings`).
- Settings > Registers: new sections "Order warnings" and "Register counts". The GECOL order warnings tab and Settings > Data > GECOL / HLC counts are hidden from the menu; their routes and endpoints stay (hide, never delete).
- Hub D55: no card. Gear and quick access: unchanged. Links and relations: none. Rights: `admin.settings`. Templates and imports: no change. Data reset: no new table (settings rows only). History: settings audit.

## Register counts
Read only. Per register: `total` (the latest version of each logical record), `versions` (all stored versions) and the records by state. The GECOL / HLC specific figures (with PR no, with request date, linked to Procurement) stay in `/reports/gecol-hlc-counts`.
