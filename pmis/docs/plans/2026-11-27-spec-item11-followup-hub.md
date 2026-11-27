# [DRAFT-SPEC] Item 11 full-screen follow-up hub with profile-completion checklist

Source: Ahmed via main (WhatsApp go-ahead 01:24 EET Nov 27 2026: implement the full proposal, settings for everything, professional execution; standing order 7:06 PM: all remaining work as PRs). Definition from Ahmed own text; main confirmed 7:21 PM.

## Agreed requirements
- A full-screen hub for follow-ups (assigned items, reminders, pending approvals) with a profile-completion checklist.
- Checklist items link to the exact setting; Settings to hide the checklist.
- Reuses the notification panel data; no new permission.

## Rules that apply
- Arabic RTL and English. A Settings entry for every behavior. Tip plus aria-label on icon buttons.
- Additive migrations only, no permission widening, nothing public, hide never delete.
- No partial coverage: the PR lists covered and excluded places and connections checked.
- A walkthrough step (Playwright EN/AR spec; real-stack run for DB-touching work).
- Changelog entry (Arabic), contract version and migration number go in the PR body, never CHANGELOG.md.
- Any new table is classified in data_reset_plan() plus pmis_reset_owner grants.
- Merge only at real 8/8 on own head, inside a main-granted window.
- Status: spec only, no code yet. Built into this same PR later.
