# Item 10: More menu as an icon grid with search

Spec (this PR started as [DRAFT-SPEC] #493). Built:

- Personal appearance dimension `more_menu` (`list` default, `grid`), through the generic appearance framework (migration 0565, mirror `db/sql/564_more_menu_mode.sql`, contract 0.15.408). Organization default, personal-choice lock, audit and the Profile > Appearance editor come with the framework. Look presets keep the personal `more_menu` choice (a working choice, not a look).
- `MoreMenu` (components/PageHeader.tsx): grid mode shows icon tiles (the item's icon, else its first letter) with a search box that filters by label, an empty-result message, Esc and arrow focus from the popover, pick closes and clears the search. EN and AR strings, RTL by logical classes.

## Covered
Every screen that uses `MoreMenu`: PageHeader/Toolbar users, TaskGrid, Sites, DailyPlan, Register (one component, one setting).

## Excluded (not a MoreMenu)
Row action menus, the column menu, the profile menu and the sidebar: they are not the "..." tool overflow of a table screen.

## Checked connections
Appearance options mirrored in web (appearance.ts), API zod (ui-prefs.ts), mock handlers (follow APPEARANCE_OPTIONS), schema.d.ts, openapi UiPrefs, migration pair, i18n EN/AR, appearance preset test.

## Changelog entry (for the PR body)
Arabic entry, contract 0.15.408, migration 0565.
