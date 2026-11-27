# [DRAFT-SPEC] Default view per screen in Settings

Source: Ahmed via main (WhatsApp go-ahead 01:24 EET Nov 27 2026: implement the full proposal, settings for everything, professional execution; standing order 7:06 PM: all remaining work as PRs). Requested by main 8:32-8:34 PM Nov 27 as part of the saved views / per-list work.

## Agreed requirements
- Each table screen lets the user pick a default saved view; stored per user and per screen.
- Settings page lists every screen with its default view selector and a reset.
- Shared screens (site-tasks, library-archive, DailyPlan, Site Master) key by table, using the column isolation stamp from #470.
- Hide, never delete views.
Migration: none expected (reuse table prefs); if needed, db/sql >= 528 / prisma >= 0529 / label >= 0.15.372 (verify live).

## Rules that apply
- Arabic RTL and English. A Settings entry for every behavior. Tip plus aria-label on icon buttons.
- Additive migrations only, no permission widening, nothing public, hide never delete.
- No partial coverage: the PR lists covered and excluded places and connections checked.
- A walkthrough step (Playwright EN/AR spec; real-stack run for DB-touching work).
- Changelog entry (Arabic), contract version and migration number go in the PR body, never CHANGELOG.md.
- Any new table is classified in data_reset_plan() plus pmis_reset_owner grants.
- Merge only at real 8/8 on own head, inside a main-granted window.
- Status: spec only, no code yet. Built into this same PR later.
