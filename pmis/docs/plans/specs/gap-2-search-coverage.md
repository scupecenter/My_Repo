# Gap 2 and extra 7: search coverage and link-aware search (Telecom Site Delivery Workspace)

Read only, no migration. `GET /search` (Ctrl+K) gains four groups and one change:

- `risks`, `issues`, `invoices`: the records of those registers, each in its own group so they are not crowded out by other registers. The generic `registers` group leaves them out. Same module right and regions as the register (the helper `registerReach`).
- `linked`: link-aware search. A record that points, through a Settings > Register links field (D60, `register_links`; the value is the entity id or id of the target), at a record whose text matches the words, and does not match them itself. Both ends must be readable by the caller, so a hidden record never appears through its neighbour. The subtitle names the matched target.
- A register hit opens the record: `/registers/{key}?record={id}`.

Not covered on purpose: sub-tasks (open PR #586) and company contacts and documents (open PR #620) are not on main yet; each adds its own group in its PR, and the `linked` group already follows any link row added in Settings. No AI features.

Web: `api/search.ts` types and order, EN/AR group names (`palette.group.*`). Contract 0.15.647.
