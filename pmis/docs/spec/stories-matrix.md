# Stories: Responsibility Matrix

Sources: CLAUDE.md "Workflow rules" and "Groups"; BP §14. The seed comes from the `entry_role` column of `task-catalogue.csv`, plus the stage owners in BP §03.

## MX-01 Matrix per stage
- **Given** the Matrix screen
  **When** an admin opens it
  **Then** it shows one row per stage (1–10, plus Dismantle and each register), with Entry, Review and Approve cells and the configured number of levels.
- **Given** a fresh installation
  **When** the seed runs
  **Then** the cells are filled as follows. ASSUMPTION: this is the default seed.
  - Entry: the sub-role from the catalogue.
  - Review: the stage's main role. For example, CW Team Lead for stages 2–4.
  - Approve: the stage's main role.
  - Final Closure: approved by the Project Manager.

## MX-02 Cell accepts users, roles, groups or a mix
- **Given** a cell
  **When** an admin adds a user, a role and a group to it
  **Then** every resolved person gets the task in their inbox, and group claim rules apply (WF-05).
- **Given** a cell
  **When** it is left empty and saved
  **Then** the save is refused, because every active level needs a holder.

## MX-02b A role in a cell resolves through assignment rows
Source: CLAUDE.md, "Role assignment is many-to-many"; AU-10.
- **Given** a Review cell that holds the role "CW Team Lead"
  **When** a task reaches Review
  **Then** the holders are the users with an *active* assignment row for that role. The row must have a permission level of review or higher, must include the task's module, and must include the site's region.
- **Given** a person who holds that role with entry rights only
  **When** holders are resolved
  **Then** they are not a holder for Review.
- **Given** the assignment rows change (added, ended or expired)
  **When** the next level transition happens
  **Then** the new holders are used. A task already claimed stays with its claimant while the claimant's row is active.
- **Given** a person who holds Entry under one role and Review under another role for the same stage
  **When** they submit
  **Then** self-skip applies (WF-04), because self-skip compares people, not roles.
- ASSUMPTION: the levels are ordered view < entry < review < approve < admin, and a higher level includes the lower ones.

## MX-03 Region-scoped holders
- **Given** a cell that holds "CW Reviewers Tripoli" and "CW Reviewers Benghazi"
  **When** a task for a Tripoli site arrives
  **Then** it is routed only to the holders whose visibility includes Tripoli (VI-02).
- **Given** a task that no holder can see
  **When** it is routed
  **Then** it goes to the System Admins with the alert "no eligible holder".
  - ASSUMPTION: this is how unroutable tasks are handled.

## MX-04 Change with step-up and audit
- **Given** a Matrix change
  **When** it is saved
  **Then** step-up MFA is required, and the audit log stores the before and after values.
  **And** the change applies to new level transitions only. Tasks already claimed stay with their claimant. (ASSUMPTION)

## MX-05 Number of levels per stage
- **Given** a stage
  **When** an admin changes its levels from 3 to 2
  **Then** the Review cell is hidden for that stage, and only tasks submitted after the change use 2 levels.

## MX-06 Self-skip preview
- **Given** a Matrix where one person holds two consecutive levels
  **When** the admin views the Matrix
  **Then** the cell shows the hint "level will be skipped for X", so the skip is visible before it happens.
