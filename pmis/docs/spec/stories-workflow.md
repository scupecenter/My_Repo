# Stories: task workflow

Sources: CLAUDE.md "Workflow rules" and "Admin overrides"; BP §03 (step states, unlocking) and §04 (batch).
Task codes and gates are defined in `task-catalogue.csv` and `rules.md`.

## WF-01 Three-level flow per task
- **Given** a stage configured with 3 levels (the default)
  **When** the entry holder fills in the task's dates and its mandatory document slots and submits
  **Then** the task becomes "Awaiting review". After review it becomes "Awaiting approval". After approval it becomes "Approved".
  **And** each step is audited with its actor and a timestamp.
- **Given** that an admin sets a stage to 2 levels (or 1 level)
  **When** a new task in that stage is submitted
  **Then** only the configured levels apply. Tasks already in flight keep the levels they started with.
  - ASSUMPTION: in-flight tasks are not changed.

## WF-02 Unit of approval is the whole task
- **Given** a task with dates and documents
  **When** it is approved
  **Then** all of its dates and document versions are approved together and locked.
- **Given** a mandatory slot that is empty
  **When** the user views the task
  **Then** "Submit for review" is disabled and the missing slot names are listed.

## WF-03 Unlocking the next task
- **Given** task X is approved with a completion date
  **When** the approval is saved
  **Then** the next task becomes Pending, with an expected date = the X date + SLA max, and its owner is notified (rules.md §3).
- **Given** a predecessor that is entered but not yet approved
  **When** the next task is opened
  **Then** it stays locked, and the lock reason names the predecessor.
- **Given** a Pending task
  **When** the stage owner sets it to Ongoing with a start date
  **Then** the default start date is today (or the TE MOS date for D6), and Ongoing does not count as done.

## WF-04 Self-skip
- **Given** the same person holds Review and Approve for a stage
  **When** they complete the review
  **Then** the Approve level is skipped, the task becomes Approved, and the audit log records "level skipped: same holder" with the "self-approval" flag.
- **Given** the same person holds Entry and Review
  **When** they submit
  **Then** Review is skipped and the task goes to Approve.

## WF-05 Group claim
- **Given** a level is assigned to a group with the rule "any one member"
  **When** a member opens the task and acts (or presses Claim)
  **Then** the task is claimed by that member and disappears from the other members' inboxes.
- **Given** a cell set to "all members must approve"
  **When** some members have approved
  **Then** the task stays at that level until every active member has approved. Any one rejection rejects it.
  - ASSUMPTION: a single rejection rejects the task under this rule.
- **Given** two members act at the same moment
  **When** the second action arrives
  **Then** it fails with "already claimed by X". Concurrency is handled with optimistic locking.

## WF-06 Reject one level back with a note
- **Given** a task at Approve
  **When** the approver rejects it with a note
  **Then** it returns to Review, and the reviewer is notified with the note.
- **Given** a task at Review
  **When** it is rejected
  **Then** it returns to Entry.
- **Given** a reject action with no note
  **When** it is submitted
  **Then** it is refused.
- Each rejection increases the task's rejection count, which feeds "first-time approval" (rules.md §9).

## WF-07 Comment thread
- **Given** any task
  **When** a user with access posts a comment (with optional @mentions)
  **Then** it is appended to the thread with author and time, and the mentioned users are notified in-app and by email.
- Comments cannot be edited after 15 minutes and cannot be deleted. (ASSUMPTION)

## WF-08 Batch approval, row by row or all at once
- **Given** an upload batch in review
  **When** the reviewer approves selected rows
  **Then** only those rows move to approval.
  **And** the rejected rows return to the uploader with a note for each row.
- **Given** "approve all"
  **When** the batch has rows held "pending previous approval"
  **Then** those rows stay held and the others proceed. The batch report lists the held rows with their reasons (BP §04).

## WF-09 Admin override
- **Given** a System Admin
  **When** they unlock a stage or task, skip it or mark it N/A, accept it without a document or without the workflow, reopen an approved task, or edit any date
  **Then** a reason and step-up MFA are required.
  **And** the audit log stores the before and after values.
  **And** the task shows an "Admin override" badge.
  **And** KPIs exclude or flag the task (rules.md §6, §9).
- **Given** an override
  **When** the admin reverses it
  **Then** the previous values are restored, and the reversal is itself audited.

## WF-10 Reopen an approved task
- **Given** an approved task reopened by an admin
  **When** it is reopened
  **Then** it returns to Entry with its values kept. Later tasks stay open.
  **And** the dependent milestones are recalculated and marked "awaiting confirmation" until the task is approved again (BP §03).

## WF-11 Site RFI special task
- **Given** a site where the BZ conditions are met (rules.md §2.1)
  **When** the RFI task is opened
  **Then** its date field is pre-filled with the latest condition date, can be edited, and needs no document.
  **And** approving it sets MS4.
