# M1: order warnings and counts for every register (generalise GECOL order warnings and the GECOL/HLC counts)

Status: built (migration 0604, contract 0.15.464; docs/ops/register-order-warnings.md). Source: the parent's relay of the owner's voice message of 2026-11-27 22:47.

## Requirement
1. Generalise the GECOL order-warnings mechanism (Q151, migration 0063, contract 0.12.11, `GecolOrderWarnings.tsx`, `gecol-order-warnings.service.ts`) to every register that has dates in a sequence (permits, readiness, and any other register with date fields). Same behaviour: ordered chains of fields, a later step dated before an earlier one warns the reviewer and never blocks, enable toggle (off by default), billing-after field, unsaved guard, mandatory reason, audit, If-Match.
2. It is configured per register from Settings > Registers (the generic structure editor), not in a GECOL-only screen.
3. Reuse the existing mechanism. No second copy of the chain logic.
4. The read-only GECOL / HLC counts (contract 0.15.84, `GecolHlcCounts.tsx`) become a generic "Register counts" view for all registers, in Settings > Registers; the old GECOL-only tab is hidden (hide, never delete), its endpoint stays.

## Design
- One generic function `reg_order_warnings(register_key, data)` takes the code of `gecol_order_warnings` (chain walk, skipped empty steps, `billing_after` against `billing_conversion_date` generalised to a configurable billing field). `gecol_order_warnings(p_data)` becomes a one-line wrapper over it, so GECOL output (code `gecol_order`, paths, messages) is unchanged.
- Setting: the existing key `gecol.order_warnings` stays as the GECOL entry; a new key `register.order_warnings` holds `{registers: {<key>: {enabled, chains, billing_after, billing_field}}}`. A migration seeds nothing (off everywhere). GECOL reads its old key first, so no data move and nothing is lost.
- `reg_warnings` gets a call to `reg_order_warnings` for every register, patched in place and idempotently from the stored function text (never redefined whole). Warning code `order` for the other registers.
- Fields offered: the register's `register_fields` of type date, including custom fields added later. Status fields are not part of a chain in this build (a list or status field has no date to compare); an order of statuses is a different rule.
- Writer `admin_save_register_order_warnings(register_key, config, reason, version)`: System Admin or a delegation of admin.settings edit for all regions, reason, If-Match per register, audit with before/after. API `GET/PUT /settings/registers/{key}/order-warnings`. The old `/settings/gecol-order-warnings` keeps working and is served by the same writer.
- Web: one `RegisterOrderWarnings` panel in Settings > Registers per register, the GecolOrderWarnings component moved into it as the generic one (props: register key); the GECOL tab entry is hidden; EN and AR; UnsavedGuard with reason as today.
- Counts: `GET /settings/register-counts` (read only) returns total, by state and the latest-version count per register; the GECOL/HLC specific figures (with PR no, with request date) stay in the old endpoint. Shown in Settings > Registers as "Register counts".

## Connections to check in the build
Registers (reviewer warning list in the drawer and the list badge), Settings > Registers, hub D55 (no card), gear/quick access, links and relations (none), rights (admin.settings), templates and imports (warnings do not run on import validation unless the import already calls `reg_warnings`; state it), data_reset (no new table: settings rows only), search, History (settings audit), EN/AR.

## Numbers (re-verify live before the build)
prisma 0604, db/sql 603, contract label 0.15.464. Order of writing: migration, API, contract plus history bullet, web, tests, one push.

## Open points
- Billing-after for registers other than GECOL needs a billing field name; the build offers any date field of the register as the billing field.
