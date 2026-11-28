# Media notices

Built in this PR. Design and rules: `docs/spec/media-gallery.md`, section "Notices".

Assumptions (to confirm):
- Recipients of a new photo are the followers of the site; recipients of "below the minimum" are the record owner and the Team Leads of the region. Region managers are taken as the Team Leads (people with the reassign grant, System Admins when there is none), the same group the notification policy already escalates to.
- "Below the minimum" counts mandatory photo slots with fewer current images than `min_files`, late after 24 hours by default, once per site and person each 7 days by default.
- New photo uses the existing kind `followed_change`; the other two use `system`, which the policy does not govern, so no catalogue entry is added.
