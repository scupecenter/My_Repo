# Stories: Audit Log and System Log

Sources: CLAUDE.md, "Workflow rules" and "Non-functional requirements".

## LG-01 Audit every user action
- **Given** any user action: create, update, submit, review, approve, reject, claim, comment, override, download, export, setting change, matrix change, delegation, login or logout
  **When** it is committed
  **Then** an audit entry is written with: time, actor, "on behalf of" (for delegates), action, entity, the field-level before and after values, reason (if any), batch ID (if any) and client IP.

## LG-02 Append-only, enforced in the database
- **Given** any database role, including the application role
  **When** it tries to UPDATE or DELETE an audit row
  **Then** the database refuses it, for example through a trigger and revoked privileges.
- **Given** the audit log
  **When** 10 years pass
  **Then** no rows are purged.

## LG-03 Search and export
- **Given** an admin or the Project Manager
  **When** they filter the audit log by date, user, site, entity or action
  **Then** results come back paginated and can be exported. The export is itself audited.
- ASSUMPTION: only admins and the Project Manager can see the audit log.

## LG-04 System / Error Log, kept separately
- **Given** a system event (rejected template upload, failed authentication, MFA refusal, background job failure, email failure, unhandled error)
  **When** it occurs
  **Then** it is written to the System Log with severity, source and a correlation ID. It is never written to the audit log.
- **Given** entries older than 12 months
  **When** the nightly job runs
  **Then** they are purged automatically.

## LG-05 Break-glass and override visibility
- **Given** a break-glass sign-in or an admin override
  **When** it happens
  **Then** it is audited with the flag `privileged`, and the System Admins receive an email (AU-08, WF-09).
