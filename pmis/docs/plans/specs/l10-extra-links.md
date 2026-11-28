# L10: extra register links ready to switch on

Status: built in this PR (migration 0596, contract 0.15.456): the rows below plus two derived ones (see Built). Further rows from the relations review table go to the parent as a list first.

Common rules: additive migrations; hide, never delete; no permission widening; nothing public; EN and AR; Settings for every feature; links and relations to existing registers stated; connections checked (registers, Settings, hub D55, gear and quick access, rights, templates) and listed in the PR body; one push per PR; contract history bullet after the 0.15.204 line, no edit of the version line; Arabic changelog entry in the PR body, not in CHANGELOG.md. Where #430 (register_links) is on main, links are register_links rows, not code.

## Agreed details
Rows only (register_links, on main since #437): lessons_learned from incidents and issues; incidents from permits_hse (PTW); the rest of the L10 table in the relations review. Each row has picker, validation and a proposal-benefit line. Proposals beyond the table go to the parent as a list first.

## Reserved numbers (re-verify live before building)
prisma 0596, label 0.15.456

## Built (0596)
- `lessons_learned.incident_id` -> incidents, `lessons_learned.issue_id` -> issues, `incidents.permit_id` -> permits_hse (PTW). Optional text fields, same site, check off.
- Picker labels: incident date and type; issue number and category; permit type and status.
- Benefit lines: a lesson names the incident or issue it came from; an incident names the permit it happened under; both sides show in the Related records panel.

## Derived rows (owner, 2026-11-28: the L10 table is not available; build the best, most complete, generic set)
Rule used: every register field that already holds the id of a record of another register, or of the same register, and has no `register_links` row gets one. Scan of `register_fields`: procurement ids were declared by 0408; `risk_entity_id`, `advance_id`, `closing_rn_id` too. Left over: `car_dispatcher.parent_booking_id` (booking) and `financial_advances.parent_advance_id` (advance), both built here. Not declared, with reason: `quality.linked_record` (free reference to any record type, no single target), `change_control.change_ticket_id` (external ticket number), `*_ref` / `*_no` fields (document numbers, not record ids), `*_user_id` (users, not register records), `vehicle_id` (fleet item). No new table, no code: the next register field that holds an id needs only a row in `register_links`.
