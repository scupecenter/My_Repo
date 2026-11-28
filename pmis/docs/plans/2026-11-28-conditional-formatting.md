# Conditional formatting rules (2026-11-28)

A person's own rules per table: "when this column meets this condition, colour the cell (or the whole row)". Example: due date more than 7 days past, red.

- Conditions by column kind: number (gt, gte, lt, lte, eq, ne), date (more than N days past, due within N days), text (contains, eq, ne), list and yes/no (eq, ne); every kind has empty and not empty. First matching rule wins; the list can be reordered. At most 20 rules.
- Colours are the status tones the app already uses (late, wait, done, open, plus grey), applied inline so they win over zebra and hover rows. A tooltip names the rule on a coloured cell or row; the text value is unchanged.
- Where: the Layout panel of the register list (Formatting section), on every register. Kept with the column prefs (this browser, like order, hidden and width) and saved with a view (`columns.rules`, shared views included).
- Rights: display only. A rule on a column the reader may not see is stripped from a shared view by `sv_strip` (migration 0670) and counted in `stripped_columns`; the screen also ignores a rule whose column it does not offer.
- Excluded: other tables (Site Master, tasks, approvals have no generic field list; they can adopt `FormatRulesEditor` and `lib/condFormat` later), rules on built-in columns (site, region, state), conditions across two columns.
