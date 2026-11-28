# C4: tools and equipment register with calibration and inspection due

Status: spec only, no code.

Common rules: additive migrations; hide, never delete; no permission widening; nothing public; EN and AR; Settings for every feature; links and relations to existing registers stated; connections checked (registers, Settings, hub D55, gear and quick access, rights, templates) and listed in the PR body; one push per PR; contract history bullet after the 0.15.204 line, no edit of the version line; Arabic changelog entry in the PR body, not in CHANGELOG.md. Where #430 (register_links) is on main, links are register_links rows, not code.

## Agreed details
New register with custodian and calibration or inspection due date; the due date feeds the expiry radar and the L5 date_approaching alert. Own L1/L2/L3 matrix seeded empty, template, links (equipment to custodian and site), data reset part, Settings, EN and AR, Arabic changelog in the PR body. Same footprint as the registers of 0184 and 0326. Source: Ahmed 2026-11-26 23:15 item 3 and 23:17 link rule.

## Reserved numbers (re-verify live before building)
prisma 0597, label 0.15.457
