# [DRAFT-SPEC] Item 12 responsive mobile layout, app banner, first-use tour

Source: Ahmed via main (WhatsApp go-ahead 01:24 EET Nov 27 2026: implement the full proposal, settings for everything, professional execution; standing order 7:06 PM: all remaining work as PRs). Definition from Ahmed own text; main confirmed 7:21 PM.

## Agreed requirements
- Real responsive mobile layout (not a shrunk desktop).
- Non-blocking app banner, dismissible, remembered.
- First-use tour, replayable from Settings; EN/AR with RTL.
- Item 13 (login) is out of this PR; owned by the login agent.

## Rules that apply
- Arabic RTL and English. A Settings entry for every behavior. Tip plus aria-label on icon buttons.
- Additive migrations only, no permission widening, nothing public, hide never delete.
- No partial coverage: the PR lists covered and excluded places and connections checked.
- A walkthrough step (Playwright EN/AR spec; real-stack run for DB-touching work).
- Changelog entry (Arabic), contract version and migration number go in the PR body, never CHANGELOG.md.
- Any new table is classified in data_reset_plan() plus pmis_reset_owner grants.
- Merge only at real 8/8 on own head, inside a main-granted window.
- Status: spec only, no code yet. Built into this same PR later.
