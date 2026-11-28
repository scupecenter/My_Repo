# [DRAFT-SPEC] Item 4 notification policy (3 PRs)

Source: Ahmed via main (WhatsApp go-ahead 01:24 EET Nov 27 2026: implement the full proposal, settings for everything, professional execution; standing order 7:06 PM: all remaining work as PRs). Approved design relayed by main. Includes Item 7 (event x channel matrix with scheduled do-not-disturb).

## Agreed requirements
- One SQL function notify_emit(...). Decision order: master switch, catalogue, recipient eligibility, admin matrix, user prefs/DND/snooze, dedupe, rate cap, write the row, enqueue email/push.
- About 25 emitters patched. CI guard fails on any raw INSERT INTO notifications.
- Additive tables: notification_prefs, notification_dedupe, notification_decisions, all classified in data_reset_plan().
- Settings: admin matrix, user Profile > Notifications, DND, test button, audit, EN and AR.
- Three PRs: core plus settings; modules A (workflow/registers/QC); modules B (digests/alerts/identity).
- Push: web push exists on main (openapi 0.15.156, GET /me/push). Use it plus the outbox and a hook. Coordinate with UI profiles agent agent-01M8D2S2ZEZMPE6YSEKBXJKATG.
Numbering reserved: migrations 0450-0469 (verify live before use).

## Rules that apply
- Arabic RTL and English. A Settings entry for every behavior. Tip plus aria-label on icon buttons.
- Additive migrations only, no permission widening, nothing public, hide never delete.
- No partial coverage: the PR lists covered and excluded places and connections checked.
- A walkthrough step (Playwright EN/AR spec; real-stack run for DB-touching work).
- Changelog entry (Arabic), contract version and migration number go in the PR body, never CHANGELOG.md.
- Any new table is classified in data_reset_plan() plus pmis_reset_owner grants.
- Merge only at real 8/8 on own head, inside a main-granted window.
- Status: spec only, no code yet. Built into this same PR later.
