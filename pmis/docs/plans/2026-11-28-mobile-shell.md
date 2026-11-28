# Item 12: mobile layout, app banner, first-use tour (built)

Below the md breakpoint (web only, no new API route, no permission change):
- Bottom bar (`MobileBar`): My Work, Inbox (unread badge), Approvals, Dashboard (only what the sidebar lists for the person) and More (opens the existing menu drawer). Safe-area aware.
- Compact top bar: breadcrumb, search label, export label and user name collapse to icons; the search, export and user buttons keep an accessible name. Content padding is smaller and leaves room for the bar.
- App banner (`AppBanner`): a thin strip under the top bar, never blocking, dismissed with one tap and remembered per person on the device. Uses the browser install prompt when offered, else says how to add the page to the home screen. Hidden when the app already runs standalone.
- First-use tour (`QuickTour`): opens once by itself as a card without overlay or focus trap, remembered per person; "Replay the tour" in My profile > Appearance opens it as the usual dialog.

Settings: appearance dimensions `app_banner` (show, hide) and `first_use_tour` (auto, manual): personal in My profile > Appearance, organization default in Settings > Identity. Migration db/sql 653 = prisma 0654 patches `ui_pref_options` and `ui_pref_defaults` in place.

Excluded: Login (item 13, other agent). Screens keep their own responsive tables; this PR changes the shell.
