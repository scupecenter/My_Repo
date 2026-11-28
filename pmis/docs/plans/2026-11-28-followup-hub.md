# Item 11: follow-up hub (built)

Route `/follow-up`, one full-screen page. It reads what the bell, My Work, Approvals and My profile already read. No new route on the API, no new permission.

Blocks: approvals waiting for me, tasks assigned to me (late, to do now, waiting), reminders (unread notices of the reminder kinds), and the profile-completion checklist.

Checklist (computed, "N of M done"): phone, appearance chosen, notification choices made, push on this browser, two-factor. An item that does not apply is not listed (administrator switched personal notification choices off, server without push, sign-in without a local password). Each open item links to the exact section of My profile (`/profile#phone`, `#appearance`, `#notifications`, `#push`, `#two-factor`); My profile scrolls to and focuses the section.

Setting: appearance dimension `followup_checklist` (`show` default, `hide`), personal in My profile > Appearance, organization default in Settings > Identity. Migration db/sql 652 = prisma 0653 patches `ui_pref_options` and `ui_pref_defaults` in place.

Entry points: bell panel footer, Inbox header, My Work header. Not a sidebar item: a nav key needs server changes (NAV_KEYS, permission catalogue); listed as a possible follow-up.
