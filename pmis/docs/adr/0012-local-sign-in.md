# ADR 0012: Local sign-in with a password (now), Microsoft 365 later

- Status: Accepted, 2026-10-28. Owner decision of 2026-10-28 replaces "local sign-in deferred" (ADR 0002 §10).
- Related: ADR 0002 (authentication), ADR 0003 (authorization, `idm_*` paths), migration `0010_local_sign_in` (`db/sql/009_local_sign_in.sql`), contract 0.3.0.

## Context
- The Entra app registration is not available yet, and the owner wants people to use the PMIS now.
- Owner answers (2026-10-28):
  1. A System Admin creates the account and gives a **temporary password**; the user must change it at the first sign-in. No email is needed.
  2. The sign-in box stays **one identifier**: 4-digit employee ID, email or phone, plus the password.
  3. **TOTP is later**, behind a switch (the existing `require_mfa` toggle will cover local sign-in as PMIS TOTP).
  4. When M365 arrives, **both methods stay**. M365 becomes the main one; local sign-in stays for special cases and the admin can turn it off per user or for everyone.

## Decision
1. **Accounts.** `POST /users` (`idm_create_local_user`) creates a user with `status = pending_assignment` and a `local_credentials` row (`must_change = true`). `users.m365_object_id` becomes nullable and `users.phone` (E.164, unique) is added. When M365 sign-in is built, the first M365 sign-in links to the existing row by the registry email (ADR 0002 §9b rules) instead of creating a second user.
2. **Passwords.**
   - Hashed by the API with argon2id (memory 64 MiB, time 3, parallelism 1, the library's PHC string). The database refuses anything that is not an argon2id PHC string.
   - Policy: 12 to 128 characters, not the current password, not containing the email local part, employee ID or phone, not in a bundled list of common passwords. No forced periodic change (NIST SP 800-63B).
   - A temporary password (admin-chosen or server-generated, 16 random characters) is returned once and never stored in clear or logged.
   - `pmis_app` cannot read `local_credentials`. It uses `auth_local_lookup` (sign-in), `auth_local_own_hash` (own step-up and password change), `auth_local_result` (lockout bookkeeping) and `auth_local_set_own_password`, all SECURITY DEFINER and owned by `pmis_identity_owner`.
3. **Sign-in.** `POST /auth/local/login {identifier, password}`.
   - Every failure is the same 401 `invalid_credentials`: unknown identifier, wrong password, locked, local sign-in off, suspended or disabled. The API runs a dummy argon2 verify when nothing matched, so timing does not reveal registration.
   - 5 failures in a row lock the account for 15 minutes (database side). Rate limits: 10 attempts per minute per IP, 5 per minute per identifier (429 `rate_limited`).
   - Every attempt writes a System Log entry; the identifier is stored only as a masked keyed hash (CLAUDE.md, security log rule).
4. **Sessions in PostgreSQL, not Redis (for now).** `user_sessions` holds the SHA-256 of a 32-byte random cookie token, the CSRF token, `auth_method`, `stepup_at`, activity and revoke fields. Same rules as ADR 0002 §1: cookie `pmis_session` (`HttpOnly`, `Secure`, `SameSite=Strict`, path `/api`), 8 hours idle (sliding, not extended by `X-PMIS-Live: 1`), 12 hours absolute, `X-CSRF-Token` on unsafe methods. Revoke sets `revoked_at` (rows are never deleted by the app). Reason: one fewer service on the internal server while there are few users; the session store is behind one interface, so Redis can replace it without touching callers.
5. **Must change password.** While `must_change` is true the guard allows only `/auth/*` and `GET /me`; everything else answers 403 `password_change_required`. The web app shows the change-password screen. Changing the password ends the user's other sessions.
6. **Step-up.** On a local session, `401 step_up_required` carries `step_up_method = password` and no `step_up_url`. The client asks for the password and calls `POST /auth/local/step-up`. Same 300-second window and same lockout counter.
7. **Admin reset.** `POST /users/{id}/password-reset` (`idm_reset_local_password`, step-up): new temporary password, unlocks, ends all the user's sessions. Not for yourself. Admins and delegates can be reset only by a System Admin (`idm_assert_user_change_allowed`).
8. **First System Admin.** The installer calls `idm_bootstrap_admin` as the database superuser or migration role (the app role cannot execute it). It creates the "System Admins" group if missing, an active user with the password typed on the server (`must_change = false`), and the membership.
9. **System Admins are not "pending".** A member of the active System Admins group is not treated as pending when they hold no assignment row (refines ADR 0002 §5): their rights come from the group.
10. **Audit.** Account creation, password change, reset, lockout and bootstrap write audit rows; sign-in attempts go to the System Log, then to the security log when it exists (db-gaps).

## Consequences
- People can use the PMIS before IT registers the Entra app.
- Local sign-in is outside Entra Conditional Access: Entra MFA and device policies do not apply to it (risk already accepted by the owner in ADR 0002 §10). TOTP closes most of the gap and is the next security item.
- Password handling is now our responsibility: hashing, lockout, rate limits and the reset flow are tested in CI (`apps/api` tests run as `pmis_app` against PostgreSQL 16).
- Deployments must run `db/sql/app_grants.sql` after migrations so `pmis_app` has its table rights and the narrowing of migrations 0002, 0009 and 0010 is applied again.
