# Stories: authentication, users, groups and administration

Every story in this file comes from CLAUDE.md, under "Decisions agreed" and "Roles, groups and administration", unless another source is cited.

## AU-01 First sign-in with Microsoft 365
As an Aljeel employee, I sign in with my company M365 account and link my 4-digit employee ID.
- **Given** a user whose Entra ID token is valid and who has no PMIS account yet
  **When** they sign in
  **Then** the system asks for a 4-digit employee ID and creates the account with status "Pending assignment".
- **Given** an employee ID that is not exactly 4 digits, or that is already linked to another account
  **When** the user submits it
  **Then** it is rejected with a reason, and the attempt is written to the System Log.
- **Given** an account in "Pending assignment"
  **When** the user opens any page or API call other than the pending page
  **Then** they see a "waiting for assignment" page and get no data back (HTTP 403 on the API).

## AU-02 Only Aljeel employees can sign in
- **Given** a token from a tenant other than the Aljeel Entra tenant
  **When** it reaches the API
  **Then** it is refused and the refusal is written to the System Log.
- **Given** an external party (vendor, contractor, GECOL, HLC or supplier)
  **When** a staff member records data for that party
  **Then** the external party is stored as the `responsible_party` of the task, not as a user. External parties never get an account.

## AU-03 Admin assigns a pending user
- **Given** a System Admin on the Users & Roles screen
  **When** they give a pending user a team (CW / TE / both), a status, and at least one role assignment row (AU-10)
  **Then** the account becomes Active. The user sees only what their active assignments allow on their next request.
  **And** the audit log records the change with before and after values.
- **Given** a role, matrix or group change
  **When** the admin saves it
  **Then** step-up re-authentication is required first (AU-07).

## AU-10 The assignment row
Source: CLAUDE.md, "Role assignment is many-to-many".
- **Given** an assignment
  **When** it is stored
  **Then** it is one row with: user, role (a main role or a sub-role), permission level (view / entry / review / approve / admin), regions (one or more of the 7, or all), modules (one or more, or all), valid from, valid to (optional), and status.
- **Given** a person who holds "TE Team Lead" with approve rights for all regions, and "Site Engineers (CW)" with entry rights for Tripoli
  **When** they act
  **Then** each role is checked against its own row. They can approve TE tasks anywhere, but can only enter data for CW tasks at Tripoli sites.
- **Given** a row whose valid-to date has passed, or whose valid-from date is in the future
  **When** permissions are evaluated
  **Then** the row is ignored. No manual action is needed when it expires.
- **Given** a user with no active row
  **When** they sign in
  **Then** they see only the pending or no-access page.
  - ASSUMPTION: an active user with no active row loses access in the same way as AU-01.

## AU-11 Assign by role, to many employees at once
- **Given** an admin who picks the role "Site Engineers (TE)"
  **When** they search the list of registered employees (everyone who has signed in with M365), multi-select 12 names, and set one permission level, regions, modules and validity
  **Then** 12 assignment rows are created in one action.
  **And** each row is written as its own audit entry, and all 12 entries share one bulk-action ID.
- **Given** that one of the selected employees already holds that role with an overlapping validity period
  **When** the action runs
  **Then** that person is skipped and listed with the reason "already assigned".
  **And** the other rows are created.
  - ASSUMPTION: the existing row is kept and no duplicate is created.

## AU-12 Assign by person, many roles to one employee
- **Given** an admin on a person's page
  **When** they add a second main role and three sub-roles, each with its own level, regions, modules and validity
  **Then** the person holds all of them at the same time.
  **And** their inbox shows tasks from every role they hold.
- **Given** a person who holds roles under different main roles (for example Site Engineers (CW) and Site Engineers (TE))
  **When** the rows are saved
  **Then** the save is allowed. The sub-role mapping (AU-04) does not limit which roles a person can hold.

## AU-13 Bulk actions
- **Given** a selection of assignment rows
  **When** the admin uses "remove"
  **Then** the rows are ended by setting valid-to to today, not deleted, so that history is kept.
  **And** any tasks those users have claimed under the removed role return to the Matrix cell (AU-09).
  - ASSUMPTION: remove means ending the row, not deleting it.
- **Given** a source person A and a target person B
  **When** the admin uses "copy assignments from A to B"
  **Then** all of A's active rows are copied to B with the same level, regions, modules and validity. Rows B already holds are skipped.
  **And** the admin sees a preview before confirming.
- **Given** an approved assignment template (TI-01; ASSUMPTION template ID `TPL-USERS`)
  **When** it is uploaded
  **Then** it goes through validation (employee ID registered, role exists, level, regions and modules valid), a diff preview, then review and approval (TI-04, TI-05).
  **And** only after approval are the rows created or ended.
- **Given** any bulk action
  **When** it is confirmed
  **Then** step-up MFA is required (AU-07). Every row change is audited with before and after values.

## AU-04 Default roles and sub-roles are seed data
- **Given** a fresh installation
  **When** the seed runs
  **Then** it creates the 6 main roles and 9 sub-roles with the agreed mapping:
  - RF Engineer, MW Engineer and Acquisition Team under RF & Design / Acquisition TL.
  - Power Engineer, GECOL Power Team, HLC Fiber Team and Site Engineers (CW) under CW TL.
  - Site Engineers (TE) and HOTO Engineer under TE TL.
  - Project Procurement Team under Project Support.
- **Given** that mapping
  **When** an admin edits it in the UI
  **Then** the change is saved and audited, and no code change is needed.
- Note: the Master Setting StaffRole list has different values (see open-questions Q8).

## AU-05 Groups
- **Given** an admin
  **When** they create a group (for example "CW Reviewers Tripoli") and add users to it
  **Then** the group can be used in any Matrix cell (MX-02).
- **Given** a user who is deactivated
  **When** a group task is next assigned
  **Then** that user is no longer in its inbox.

## AU-06 System Admin group and delegation
- **Given** the "System Admins" group
  **When** an admin tries to remove the last active admin
  **Then** the action is blocked with the message "at least one active admin must exist".
- **Given** an admin delegating full or partial rights, either until a set date or until revoked
  **When** the delegate acts
  **Then** the audit entry reads "X on behalf of System Admin".
  **And** the delegation stops at its end date without any manual step.
- **Given** a delegate
  **When** they try to re-delegate, or to remove an admin
  **Then** the action is refused and the refusal is logged.

## AU-07 MFA and step-up
- **Given** the admin toggle "Require MFA claim" is on
  **When** a token without `mfa` in its `amr` claim calls the API
  **Then** the request gets 401 with the reason "mfa_required".
- **Given** the toggle is off (the default until IT enables MFA)
  **When** a token without `mfa` arrives
  **Then** it is accepted.
- **Given** a final approval, a role / matrix / group change, a delegation, a delete or an admin override
  **When** the user confirms it
  **Then** a fresh re-authentication is required.
  - ASSUMPTION: the authentication must be no older than 5 minutes (configurable).
  **And** the action fails without it.

## AU-08 Break-glass local admin
- **Given** the single break-glass account (password plus TOTP)
  **When** it signs in from the internal network
  **Then** access is granted, every use is logged, and an email goes to all System Admins.
- **Given** the same account
  **When** it is used from outside the internal network ranges (configured)
  **Then** sign-in is refused and the attempt is logged.

## AU-09 Deactivate a user
- **Given** an admin sets a user's status to Inactive
  **When** that user next makes a request
  **Then** access is refused.
  **And** the user's open claimed tasks return to their group or Matrix cell, with an audit entry.
  - ASSUMPTION: claimed tasks are released this way.
