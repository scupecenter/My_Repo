# Standard context menu

One menu for every list, opened by right-click, Shift + F10 or the Menu key. Shift + right-click and any text field keep the native browser menu.

## What it reuses
The row menu that already ships (`RowActions`, mounted once in the shell). It is extended, not copied.

## Items
Open, Open in a new tab, Select, Copy link, Copy value (the cell under the pointer), Copy row, and, when the element holds an enabled control marked `data-ctx-action`: Edit, Assign, Change status, Duplicate, Delete. Delete asks for a second click on "Confirm delete".

## Rights
The menu never decides what a person may do. An item exists only when the element already holds an enabled control for it. A disabled or missing control gives no item.

## Where it applies
Grid rows (`.gx-row`) and every element marked `data-ctx`: task board cards, site board cards, Gantt rows, document grid rows. A new screen opts in with `data-ctx` and, for actions, `data-ctx-action`.

## Language and keys
English and Arabic labels, mirrored placement in right-to-left, arrows, Home, End, Enter, Escape.
