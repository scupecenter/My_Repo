# L4: operational dashboard cards for invoices, warehouse, risks and issues

Status: spec only, no code.

Common rules: additive migrations; hide, never delete; no permission widening; nothing public; EN and AR; Settings for every feature; links and relations to existing registers stated; connections checked (registers, Settings, hub D55, gear and quick access, rights, templates) and listed in the PR body; one push per PR; contract history bullet after the 0.15.204 line, no edit of the version line; Arabic changelog entry in the PR body, not in CHANGELOG.md. Where #430 (register_links) is on main, links are register_links rows, not code.

## Agreed details
Priority map, each card managed from Settings > Dashboard like the existing ops cards (0300-0303): (1) invoice ages and due dates (dates exist since 0185); (2) pending warehouse movements; (3) stale open risks and issues (with the record_idle alert). Today only permits_hse, gecol+hlc, contractors and quality have ops cards.

## Reserved numbers (re-verify live before building)
prisma 0590, label 0.15.450
