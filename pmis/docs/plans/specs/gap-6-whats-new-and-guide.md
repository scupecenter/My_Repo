# Gap 6: What's new page and short guide (Telecom Site Delivery Workspace)

Two read-only screens in the user menu, no migration and no API:

- `/whats-new`: release notes from `apps/web/src/content/whatsNew.ts`, newest first, each with a link to its screen. A dot on the menu item shows while the newest note is newer than the one this browser opened last (local view preference `pmis.whatsnew.seen`, no data, no setting).
- `/guide`: seven short sections (signing in, my work, registers, templates and import, notifications, settings, help).

Text is in `en.json` and `ar.json` (`whatsNewItems.*`, `guide.*`, `top.*`); Arabic is Modern Standard Arabic. A feature that changes what people see adds one entry to `whatsNew.ts` and two i18n blocks in its own pull request. The Arabic training material (`docs/customer/05-training-ar.md`, section 6) describes both screens.

Not covered on purpose: notes for features still in open pull requests (they add their own entry when they land), and no per-role or per-company guide text (the guide is the same for everyone and holds no data).
