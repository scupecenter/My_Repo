# Spec: staff registry

Owner: `people-registry` agent. Sources: CLAUDE.md "Staff registry" (settles B13), B3, B12b. Draft data: `db/seed/staff-registry.draft.csv` (25 synthetic rows, checked by `tools/staff-registry/check_registry.py`).

## 1. Fields and validation
| Field | Rule |
|---|---|
| `employee_id` | Required, exactly 4 digits, unique across all rows (also inactive). Never reused. |
| `name_en`, `name_ar` | Required. |
| `email` | Required, valid address, unique. Synthetic data uses `@example.com`. Personal data. |
| `phone` | Required, `+218 9X XXX XXXX`, unique. Personal data. |
| `position` | Required free text (English label for now, see Open). |
| `team` | `CW`, `TE`, `both` or `none`. |
| `main_role` | One of the 6 main roles. A starting value only: the real role comes from the admin's assignments on Users & Roles. |
| `region` | One of Tripoli, Middle, WM, Zawia, Benghazi, GM, Sebha, or `All`. Home region for display; it does not limit visibility (that stays in the assignments, B3). |
| `status` | `active` or `inactive`. |
| `notes` | Optional. |

## 2. Maintenance
- Create, edit, deactivate and import are System Admin actions, or delegated ones (same grant model as other configuration).
- Each change is audited with before/after values and a reason.
- Rows are deactivated, never deleted. An inactive person keeps their ID and history, cannot sign in, and stays visible on old tasks (card shows "Inactive").
- Changing an `employee_id` that is linked to an account is blocked; deactivate and add a new row instead.

## 3. Import from an approved template
- Template `TPL-STAFF` is issued by the system like other templates (TI-01): hidden sheet `_tpl` with `template_id` = `TPL-STAFF` and `version` (seed `1.0`), locked headers, drop-downs for team, region and status, an instructions sheet.
- Upload follows TI-02: no `_tpl`, unknown ID or retired version is rejected with a reason and written to the System Log.
- Flow: batch, then diff preview (new / changed / unchanged / error rows), then approval, then applied. Rows absent from the file are left untouched (no delete).
- Whole-file rule: if any row fails validation (duplicate ID, bad phone, unknown region) the rows are listed with reasons and the admin may import the valid ones only.

## 4. First sign-in matching
1. User signs in with M365, then enters a 4-digit employee ID.
2. The ID must exist in the registry, be `active`, and not be linked to another account. Otherwise sign-in stops with a generic message ("ID not found or already in use") so IDs cannot be probed; the attempt is audited.
3. On success the account is linked to the registry row and stays "Pending assignment" until an admin assigns roles. The link is audited.
4. Unlinking (for example a mistyped ID) is an admin action with a reason.

## 5. Hover card
- Shown wherever a person holds a task: task grid, task drawer, Approvals, My Work, matrix. The employee ID is always printed beside the name.
- Contents: name EN and AR, employee ID, position, team, region, email, phone, "Inactive" badge when relevant.
- Field-level visibility: email and phone follow field-level permissions. Default: any signed-in Aljeel employee sees them; an admin can limit each to admins or to named roles. A hidden field shows "Not visible to you", never blank.
- Keyboard: the name is focusable (Tab); focus opens the card, blur or Escape closes it. Escape closes the card before any drawer or dialog behind it.
- Pointer: opens on hover, stays open while the pointer is over the card, closes shortly after it leaves.
- Touch: a tap opens it, a tap elsewhere closes it; the tap does not trigger the row action.
- Markup: `role="tooltip"`, trigger gets `aria-describedby` while open. Arabic: the card follows the page direction, phone and email stay LTR, the AR name is `dir=rtl`. Dark theme uses the shared tokens. All data is escaped.
- The card is also read through the API for the person being shown, so the server (not the client) applies field visibility.

## 6. Audit
Create, edit, deactivate, reactivate, import (batch ID, counts), link and unlink at sign-in, and every change to the visibility settings are audited with actor, before/after and reason. Reads of phone and email through the card API are not logged individually (ASSUMPTION; confirm with security).

## 7. Acceptance criteria
- **SR-01** Given a registry row with ID 1204 and no linked account, when a user enters 1204 at first sign-in, then the account links to it and shows "Pending assignment".
- **SR-02** Given ID 1204 is linked to another account, an unknown ID or an inactive row, when entered, then sign-in is refused with the generic message and the attempt is audited.
- **SR-03** Given an admin deactivates a row, when anyone opens a task it held, then the name and ID still show with "Inactive", and no delete action exists.
- **SR-04** Given a file without a valid `_tpl` for `TPL-STAFF`, when uploaded, then it is rejected and logged. Given a valid file with a duplicate ID, then that row is an error in the preview and the others can be imported.
- **SR-05** Given a task shown in the grid, drawer, Approvals or My Work, when the assignee is displayed, then the 4-digit ID is beside the name.
- **SR-06** Given the pointer over a name, or keyboard focus on it, when it happens, then the card opens with the registry data; when Escape is pressed or focus leaves, then it closes and an open drawer stays open.
- **SR-07** Given phone is limited to admins, when a non-admin opens the card, then email shows and phone shows "Not visible to you".
- **SR-08** Given Arabic RTL and the dark theme, when the card opens, then it is fully inside the viewport and uses theme colours.
- **SR-09** Given a touch device, when the name is tapped, then the card opens without opening the row; a tap elsewhere closes it.
- **SR-10** Given any registry change, then an audit entry exists with before/after values.

## 8. Requests to other agents
**database-engineer** (proposal, not applied): table `staff_registry`
- `employee_id char(4) primary key check (employee_id ~ '^[0-9]{4}$')`
- `name_en text not null`, `name_ar text not null`
- `email citext not null unique`, `phone text not null unique check (phone ~ '^\+218 9[0-9] [0-9]{3} [0-9]{4}$')`
- `position text not null`, `team text not null check (team in ('CW','TE','both','none'))`
- `main_role text`, `region text not null check (region in ('Tripoli','Middle','WM','Zawia','Benghazi','GM','Sebha','All'))`
- `status text not null default 'active' check (status in ('active','inactive'))`, `notes text`
- `created_at`, `updated_at`, `updated_by`; no delete (revoke DELETE, trigger blocks it); writes through `app_has_permission`; audit trigger with before/after.
- `users.employee_id` references it with a unique constraint (one account per ID).
- Field-level visibility settings for `email` and `phone` as configuration rows.

**tech-lead** (for `contracts/openapi.yaml`):
- `GET /staff-registry?q=&team=&region=&status=&page=` list and search (admin).
- `GET /staff-registry/{employee_id}` card data; email and phone omitted or null with `hidden: true` when the caller lacks the field permission.
- `POST /staff-registry`, `PATCH /staff-registry/{employee_id}` (reason required), `POST /staff-registry/{employee_id}/deactivate` and `/reactivate`.
- `GET /templates/TPL-STAFF`, `POST /staff-registry/import` (batch, diff preview, approve), reusing the batch flow.
- First sign-in check: `POST /auth/link-employee` with the same generic error for not found, inactive and already linked.

## 9. Open
- The owner asked that a user may sign in with email, employee ID or phone. How this combines with M365 SSO (Entra remains the identity provider; the three would only be ways to identify the person) is pending the owner's answer. No password or OTP login is designed here.
- Position has no Arabic label; a controlled positions list with EN/AR is proposed.
- Whether card reads of personal data are audited.
