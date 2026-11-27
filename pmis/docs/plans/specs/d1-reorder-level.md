# D1: reorder level and low-stock alert

Status: spec only, no code.

Common rules: additive migrations; hide, never delete; no permission widening; nothing public; EN and AR; Settings for every feature; links and relations to existing registers stated; connections checked (registers, Settings, hub D55, gear and quick access, rights, templates) and listed in the PR body; one push per PR; contract history bullet after the 0.15.204 line, no edit of the version line; Arabic changelog entry in the PR body, not in CHANGELOG.md. Where #430 (register_links) is on main, links are register_links rows, not code.

## Agreed details
Reorder level per warehouse item, a low-stock alert, thresholds in Settings, edit by warehouse roles. Reads the central items of #458. The alert uses the 0342 alert structure.

## Reserved numbers (re-verify live before building)
prisma 0598, label 0.15.458
