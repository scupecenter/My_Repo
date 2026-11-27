# L8: notice when a new module has no grants

Status: spec only, no code.

Common rules: additive migrations; hide, never delete; no permission widening; nothing public; EN and AR; Settings for every feature; links and relations to existing registers stated; connections checked (registers, Settings, hub D55, gear and quick access, rights, templates) and listed in the PR body; one push per PR; contract history bullet after the 0.15.204 line, no edit of the version line; Arabic changelog entry in the PR body, not in CHANGELOG.md. Where #430 (register_links) is on main, links are register_links rows, not code.

## Agreed details
Inbox notice to System Admins when a module first appears with no permission holders (module invoices has no grants, open the Matrix) plus a badge on the Matrix screen; one line in the reg_notify_admins pattern. Seeds stay empty (no widening).

## Reserved numbers (re-verify live before building)
prisma 0594, label 0.15.454
