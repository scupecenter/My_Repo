# L7: import validates link fields

Status: spec only, no code.

Common rules: additive migrations; hide, never delete; no permission widening; nothing public; EN and AR; Settings for every feature; links and relations to existing registers stated; connections checked (registers, Settings, hub D55, gear and quick access, rights, templates) and listed in the PR body; one push per PR; contract history bullet after the 0.15.204 line, no edit of the version line; Arabic changelog entry in the PR body, not in CHANGELOG.md. Where #430 (register_links) is on main, links are register_links rows, not code.

## Agreed details
At staging: a link value that is not a UUID or points to no existing record becomes a clear row error in the error report (P4). Reuse the 0181 link rules. Today a wrong UUID passes silently.

## Reserved numbers (re-verify live before building)
prisma 0593, label 0.15.453
