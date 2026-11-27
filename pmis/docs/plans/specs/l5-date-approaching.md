# L5: date_approaching alerts

Status: spec only, no code.

Common rules: additive migrations; hide, never delete; no permission widening; nothing public; EN and AR; Settings for every feature; links and relations to existing registers stated; connections checked (registers, Settings, hub D55, gear and quick access, rights, templates) and listed in the PR body; one push per PR; contract history bullet after the 0.15.204 line, no edit of the version line; Arabic changelog entry in the PR body, not in CHANGELOG.md. Where #430 (register_links) is on main, links are register_links rows, not code.

## Agreed details
Third alert type date_approaching {register_key, date_field, days_before} on the 0342 structure (EN/AR template, closed audience, dedupe). Fields: invoices due_date, permits valid_to, contractors safety_cert_expiry and contract_end; C4 calibration due joins when C4 exists. Today only record_idle and weekly_status_missing exist.

## Reserved numbers (re-verify live before building)
prisma 0591, label 0.15.451
