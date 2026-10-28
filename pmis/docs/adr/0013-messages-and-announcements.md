# ADR 0013: Messages between employees and their managers, and announcements with an answer

- Status: Accepted, 2026-10-28 (owner request and answers of 2026-10-28).
- Related: CLAUDE.md "Messages and announcements", migration `0011_messages_announcements` (`db/sql/010_messages_announcements.sql`), contract 0.4.0, ADR 0003 (authorization), ADR 0012 (local sign-in).

## Context
The owner wants a screen for messages between employees and their managers, and announcements to everyone or to chosen
users, groups, roles and departments. A recipient answers an announcement in a pop-up with agree or disagree; a
disagreement needs a note. The PMIS had no direct manager and no department, so both are added.

Owner answers (2026-10-28):
1. Messages are between an employee and their **direct manager**, a new field set by the admin. A System Admin can write to anyone.
2. "Departments" are an **admin-managed list**; each employee belongs to one.
3. The announcement pop-up is **blocking**: the app cannot be used until the person answers.
4. The answers are seen by the **sender and the System Admins**, with a results screen and an export.

## Decision
1. **Direct manager and department.** `users.manager_id` and `users.department_id`, set together by `idm_set_user_org` (users.edit, all regions, step-up; admins and delegates by a System Admin only; no manager loops; the manager must be active, the department active). Departments are kept in `departments` (code, EN/AR name, active flag), edited by `idm_department_save`, never deleted. Both are identity data written only by functions owned by `pmis_identity_owner`.
2. **Messages.**
   - A thread has a subject, two participants and an original message. Either side of a manager link may start it; a System Admin may start one with any active user. Anyone else is refused in the database (`msg_can_start`).
   - Replies come from the two participants only. The thread shows the original message first, then the replies **newest first**.
   - Only the two participants can read a thread, enforced by row-level security; a System Admin who is not a participant cannot read it. Messages are append-only (trigger). Each participant has a `last_read_at` for unread counts.
   - A thread keeps working after the manager link changes; the link only decides who can start a new one.
3. **Announcements.**
   - Sent by a System Admin or a delegate holding `announcements.create` (`ann_send`). The audience is everyone, or any mix of users, groups, roles (an assignment valid today) and departments.
   - **The recipients are fixed when it is sent** (`announcement_recipients`): active users who match, never the sender. A person who joins later does not receive it. This keeps the results exact and auditable.
   - Each recipient answers once (`ann_respond`): `agree`, or `disagree` with a note of at least 3 characters, enforced by a check constraint. Answers are append-only.
   - The web app shows unanswered announcements, oldest first, as a pop-up that cannot be dismissed. The API does not block other calls, because the pop-up is a UI duty and a background call must not fail because of it.
   - Results (counts, every recipient's answer and note, who has not answered) are readable by the sender and System Admins only (row-level security), with a CSV export that opens in Excel. Sending and exporting are audited.
4. **Navigation.** "Messages" for every active user, with an unread count. "Announcements" for System Admins and holders of `announcements.create`: send, list and results. Departments and the manager field live on the Users & Roles screen.
5. **Notifications by email** are not part of this step; the in-app unread count and the pop-up are. Email comes with the notification service (P2).

## Consequences
- Org data (manager, department) is now part of identity and must be kept current by admins. Without a manager, an employee can only receive messages from a System Admin, or from people who report to them.
- Admins cannot read private threads, which protects employees. Abuse is handled outside the system or by a later moderation rule; that would be a new ADR.
- A blocking pop-up stops work until the person answers, so senders should keep announcements rare and short.
