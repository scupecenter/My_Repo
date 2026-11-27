# D3: data-quality report (read only)

Status: spec only, no code.

Common rules: additive migrations; hide, never delete; no permission widening; nothing public; EN and AR; Settings for every feature; links and relations to existing registers stated; connections checked (registers, Settings, hub D55, gear and quick access, rights, templates) and listed in the PR body; one push per PR; contract history bullet after the 0.15.204 line, no edit of the version line; Arabic changelog entry in the PR body, not in CHANGELOG.md. Where #430 (register_links) is on main, links are register_links rows, not code.

## Agreed details
Read-only report: required fields empty, dates out of order, sites without contractor or team, orphan id columns (relations-map 4.5), missing photos per photo_rules from D6. Obeys field permissions and regions. No writes.

## Reserved numbers (re-verify live before building)
prisma 0599, label 0.15.459
