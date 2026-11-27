# P1 Users & Roles: five stacked rows become two

Row 1 is the tab strip: Users, Roles and profiles, Groups, Delegation, Responsibility Matrix, Assignments, Departments, Invitations (caret menu: Email changes, Phone changes), Online now. Row 2 is the toolbar (search, Status, Roles, + Filter, count, Invite, New user, Assign roles).

- Deleted is now a Status filter value (it shows the deleted list; restore and purge unchanged).
- Departments, Invitations, Email changes, Phone changes are `/admin/users?view=departments|invitations|email_changes|phone_changes`. Old `?email_changes` / `?phone_changes` links still work. Routes and permissions are unchanged (Online: `manage_users`; changes: users.edit for all regions).
- The duplicate "Users" heading and the Users/Assignments second row are gone; Assignments is a tab. Permission profiles keep their small row under Roles.
- Test ids: `users-tab-departments|invitations|online` and `users-tab-email_changes|phone_changes` are kept (now in the strip). `users-tab-active` is `people-tab-users`; `users-tab-deleted` is the `users-filter-status` value `deleted`.
