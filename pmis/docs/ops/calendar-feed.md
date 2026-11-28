# Personal calendar feed (D4, contract 0.15.460, migration 0600)

Profile > My calendar feed. A private link a calendar app subscribes to.

- Off by default. A person turns it on in their own profile; the link is shown once. Only the SHA-256 hash is stored (table `calendar_feed_tokens`, one row per person).
- Make a new link: the old link stops at once. Turn off: the row is removed and the link stops at once. A wrong, rotated or revoked link answers 404.
- Content: only the person's own items. Open tasks pinned to them with a planned date, and the Valid To date of the approved permits they created. Site code, title and code only. Nothing about other people.
- The read (`GET /me/calendar-feed/{file}`) has no session. It calls the definer function `calendar_feed_events(hash)`, which runs nothing as a person and widens no right. Not cached.
- Data reset: KEEP (identity and access state).
- Limits: tasks held by a group (not pinned to the person) are not listed; use My Work for those.
