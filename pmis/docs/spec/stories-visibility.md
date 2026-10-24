# Stories: visibility

Sources: CLAUDE.md, "Workflow rules" (visibility) and the default stack line "row-level region filter".

## VI-01 Default is everything
- **Given** an active user with no restrictions
  **When** they open any list
  **Then** they see all regions and all modules their permission level allows.

## VI-02 Region restriction
- **Given** a user limited to Tripoli and Zawia
  **When** they open the site grid, a register, the dashboard, an export, a search or a zip download
  **Then** only rows for sites in those regions are returned. The filter is applied on the server.
- **Given** the same user
  **When** they request a site in Benghazi by its ID
  **Then** they get 404. The API does not reveal that the site exists. (ASSUMPTION)
- Regions are the 7 values: Tripoli, Middle, WM, Zawia, Benghazi, GM and Sebha. The Master stores them as "Tripoli Area" and so on (see open-questions Q10).

## VI-03 Module restriction
- **Given** a user whose modules are limited to Warehouse and Quality
  **When** the menu is shown
  **Then** only those modules appear.
  **And** API calls to any other module return 403.

## VI-03b Visibility from several assignments
Source: CLAUDE.md, "Role assignment is many-to-many"; AU-10.
- **Given** a user with two active rows: Tripoli for all modules, and Benghazi for Warehouse only
  **When** they open the Warehouse module
  **Then** they see Tripoli and Benghazi sites.
- **Given** the same user
  **When** they open Quality
  **Then** they see Tripoli sites only.
- Read visibility is the union of the user's active rows, per module.
- Write rights are checked against the single row that matches the role used for the action (AU-10), never against the union.
- **Given** a row that expires
  **When** the next request is made
  **Then** the regions and modules it granted are no longer visible, unless another active row grants them.
- ASSUMPTION: the union rule above.

## VI-04 Aggregates respect visibility
- **Given** a region-limited user
  **When** they view dashboard totals, Project Status or the health index
  **Then** the figures are computed only from the sites they can see.
  **And** project-wide central items (Project Status 1.3, 1.5, 3.2–3.10 and the others listed in rules.md §6) are hidden.
  - ASSUMPTION: these central items are hidden for region-limited users.

## VI-05 Pending users see nothing
- See AU-01.

## VI-06 Rows without a region
- **Given** a register row without a Site ID (for example a contractor, or a Risk with no affected site)
  **When** a region-limited user lists the register
  **Then** the row is shown if the user has that module.
  - ASSUMPTION: rows not tied to a site are visible to everyone with module access.
