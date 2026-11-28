# Links: orphans alert (spec, D60 follow-up)

Status: proposal for the tech lead. Spec only, nothing is built by this PR.

## Where it stands (verified in code)
- `register_link_orphans()` (migration 0409, `db/sql/408_register_links.sql`, PR #430) is a read-only SQL report: per declared link, how many current rows hold an id that is not a current record of the target. It has no API route, no web screen, no alert and no notification.
- #437 (filters), #445 (site Linked records tab) and #417 (finance alert kinds) do not touch it. #359 dropped its own catalogue.
- So today nobody is told when a link leaves records dangling. The report is only for the manual check before `enforce` is switched on.

## Proposal
1. **Alert kind `link_orphans`** for the generic alert rules (`alert_rules`).
   - Params: `register_key` and `field_code` (optional, empty = every declared link), `min_rows` (1..10000, default 1).
   - Fires once per declared link whose orphan count is at least `min_rows`, through `alert_rule_notify` (in-app), deduped by `alert_rule_fires` (key = register, field, and the day the count changed). Message: register, field, target, count, with a link to the list.
   - Done as in 0408: a CHECK on kinds, and `alert_rule_params_errs` and `alert_rules_run` patched in place (never replaced whole).
2. **Read route** `GET /registers/link-orphans` (rights: the Settings editor of register links; no widening) returning the report rows plus up to 20 example record ids per link, so the alert can open them.
3. **Settings editor**: a badge per link with the orphan count, and a warning when switching `enforce` on while the count is above zero (the switch stays allowed, the user sees the number first).
4. **Seed rule**: one disabled `link_orphans` rule per region admin is NOT seeded (no default widening); the owner turns it on.
5. Connections to check when built: alert rules screen, Settings links editor, relations-map and alert-rules docs, openapi history, mocks, EN/AR strings, audit of rule changes, export of the report (CSV through the existing export door), reset plan (no new table, so none).

## Out of scope
Auto-fixing or clearing dangling ids (hide, never delete); changing any `enforce` value.

## Needs from Main
Migration and contract numbers at build time (db >= 521, prisma >= 0522, label >= 0.15.365, to re-verify live).
