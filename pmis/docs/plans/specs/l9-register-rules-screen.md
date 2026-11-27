# L9: register rules keys in Settings

Status: spec only, no code.

Common rules: additive migrations; hide, never delete; no permission widening; nothing public; EN and AR; Settings for every feature; links and relations to existing registers stated; connections checked (registers, Settings, hub D55, gear and quick access, rights, templates) and listed in the PR body; one push per PR; contract history bullet after the 0.15.204 line, no edit of the version line; Arabic changelog entry in the PR body, not in CHANGELOG.md. Where #430 (register_links) is on main, links are register_links rows, not code.

## Agreed details
Show the rules keys of every register in the register columns screen (section Register rules) instead of editing JSON by SQL; the invoice currency rules.currency = LYD is the first. Complete screen-to-setting coverage list belongs to the gear proposal G4.

## Reserved numbers (re-verify live before building)
prisma 0595, label 0.15.455
