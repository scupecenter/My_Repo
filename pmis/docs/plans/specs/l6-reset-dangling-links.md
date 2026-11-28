# L6: data reset shows links that would become dangling

Status: built (migration 0641, contract 0.15.540).

Common rules: additive migrations; hide, never delete; no permission widening; nothing public; EN and AR; Settings for every feature; links and relations to existing registers stated; connections checked (registers, Settings, hub D55, gear and quick access, rights, templates) and listed in the PR body; one push per PR; contract history bullet after the 0.15.204 line, no edit of the version line; Arabic changelog entry in the PR body, not in CHANGELOG.md. Where #430 (register_links) is on main, links are register_links rows, not code.

## Agreed details
In the reset preview (dry run): a counter per dependent part of the links that would dangle (invoices, custody, car bookings after a procurement reset), with an option to include the linked records in the scope. Information first, never blocking.

## Reserved numbers (re-verify live before building)
prisma 0641, label 0.15.540 (the numbers reserved at first, 0592 and 0.15.452, were re-assigned after a live scan of main and all open PRs).
