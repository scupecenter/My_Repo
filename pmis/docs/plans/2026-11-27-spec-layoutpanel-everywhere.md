# [DRAFT-SPEC] LayoutPanel on every remaining table screen

Source: Ahmed via main (WhatsApp go-ahead 01:24 EET Nov 27 2026: implement the full proposal, settings for everything, professional execution; standing order 7:06 PM: all remaining work as PRs). Requested as the no-partial-coverage rule for the layout panel work (P4, P3, #361).

## Agreed requirements
- ViewMenu was deleted by #361. Use LayoutPanel with views={{value, options, onChange}}.
- Scan every table screen; list covered and excluded screens and why.
- Density, columns and views in one panel; Settings toggles per screen.
Migration: none.

## Rules that apply
- Arabic RTL and English. A Settings entry for every behavior. Tip plus aria-label on icon buttons.
- Additive migrations only, no permission widening, nothing public, hide never delete.
- No partial coverage: the PR lists covered and excluded places and connections checked.
- A walkthrough step (Playwright EN/AR spec; real-stack run for DB-touching work).
- Changelog entry (Arabic), contract version and migration number go in the PR body, never CHANGELOG.md.
- Any new table is classified in data_reset_plan() plus pmis_reset_owner grants.
- Merge only at real 8/8 on own head, inside a main-granted window.
- Status: spec only, no code yet. Built into this same PR later.
