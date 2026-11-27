# D4: personal revocable ICS feed

Status: spec only, no code.

Common rules: additive migrations; hide, never delete; no permission widening; nothing public; EN and AR; Settings for every feature; links and relations to existing registers stated; connections checked (registers, Settings, hub D55, gear and quick access, rights, templates) and listed in the PR body; one push per PR; contract history bullet after the 0.15.204 line, no edit of the version line; Arabic changelog entry in the PR body, not in CHANGELOG.md. Where #430 (register_links) is on main, links are register_links rows, not code.

## Agreed details
Per-user feed of own planned dates and permit expiries, a secret token that can be revoked and rotated, nothing public by default, shown and managed in the user's own settings. Never lists other people's data.

## Reserved numbers (re-verify live before building)
prisma 0600, label 0.15.460
