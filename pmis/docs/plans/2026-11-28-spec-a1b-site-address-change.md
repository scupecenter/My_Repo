# Spec: A1b, the address as a Change Control field
Status: built in this PR (migration 0611, contract 0.15.471).

## Requirement
A1 offers to propose the latitude and longitude of the selected acquisition candidate. The candidate also carries an address, and the change proposal had no address field. Cover it with an additive change: the optional `address` on the identity proposal, with the same approval path.

## Built
- Change Control item `site.address`, modelled on `site.name_ar` (empty clears, shown as (none), at most 500 characters, control characters removed). Ten SQL functions are patched in place from their stored text (idempotent, anchors asserted).
- `identity.address` on `POST /sites/{id}/change-proposals` and on the System Admin direct edit. No new path, table or grant. The identity guard trigger is not touched.
- Web: Address field in Site identity and in the admin edit, mock and tests, English and Arabic labels.
- The A1 panel proposes the candidate's address too (follow-up on the A1 PR once this contract is on main).

## Places covered and excluded
Covered: Change Control, Site identity, admin edit with revert, audit, openapi, customer docs. Excluded with reason: Settings, matrix, lookups, filters, dashboards, notifications, exports and search need no change, since the address column and its existing reads are unchanged.
