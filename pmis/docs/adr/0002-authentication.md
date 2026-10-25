# ADR 0002: Authentication

- Status: Accepted (tech-lead), 2026-10-24. Items 6 and 7 need confirmation from the M365 admin (spike P1-BE-01).
- Related: CLAUDE.md "Two-factor authentication", "Users & Roles screen"; stories AU-01, AU-02, AU-07, AU-08, AU-09.

## Context
- Only Aljeel employees sign in, through Microsoft 365 (Entra ID). External parties never sign in.
- Each account is linked once to a 4-digit employee ID, and it stays "Pending assignment" until an admin assigns it.
- MFA is enforced by Entra Conditional Access. The API checks the `amr` claim behind an admin toggle that is off until IT enables MFA.
- Step-up re-authentication is required for final approval, role, matrix and group changes, delegation, deletes, and admin overrides.
- One break-glass local admin account exists. It uses TOTP, works only from the internal network, and every use is logged and emailed.
- A mobile app comes later.

## Decision
1. **Backend-for-frontend session.** The API is a confidential OIDC client (msal-node, authorization code flow with PKCE).
   - The browser never holds Entra tokens.
   - After the callback, the API creates a server-side session in Redis and sets the cookie `pmis_session` (`HttpOnly`, `Secure`, `SameSite=Strict`, path `/api`).
   - The session lasts 8 hours of inactivity (sliding window) and at most 12 hours.
   - Every unsafe method also needs the header `X-CSRF-Token`. Its value comes from `GET /auth/session`.
   - Reason: there are no tokens in browser storage and logout is simple. Step-up and the `amr` check happen on the server, in one place.
2. **Token validation at login.** The ID token must pass all of these checks; otherwise sign-in is refused with HTTP 401 and a System Log entry (AU-02):
   - `iss`, `aud`, signature and expiry are valid;
   - `tid` equals the configured Aljeel tenant;
   - `oid` is present.
   The user is matched on `oid` (stored as `users.m365_object_id`) and never on email.
3. **MFA toggle.** The setting `require_mfa` (default `false`) is checked at login and at step-up. When it is on and `amr` lacks `mfa`, sign-in fails with 401 and `code = mfa_required`. The session stores the `amr` value it was created with, so the audit log can show an "MFA" chip.
   - **Per-user exemption.** `users.mfa_exempt_until` (null = not exempt; a far date = until revoked) plus `mfa_exempt_reason` and `mfa_exempt_by`. When set and in the future, login and step-up skip the `amr` check for that user only. Set and cleared only through an `idm_*` function that requires the actor's step-up, forbids `actor = target`, and writes the audit row. It has no effect on Entra Conditional Access.
4. **4-digit employee ID link.**
   - On first sign-in the account is created with `status = pending_assignment` and no assignments.
   - `POST /auth/employee-id` accepts exactly 4 digits, once. The value must be unique, which the database enforces with `users.employee_id` UNIQUE.
   - A rejected attempt is written to the System Log.
   - Only an admin can change the ID afterwards (with step-up, audited).
   - There is no HR directory today, so the ID is not checked against a list of real employees (see gate report, inconsistency I-12).
5. **Pending assignment.**
   - A `pending_assignment` user gets an empty region set (`app.region_ids = ''`, ADR 0003), so the database returns no rows.
   - The API's global guard allows only `/auth/*`, `GET /me` and `POST /me/notify-admins`. Every other call returns 403 with `code = pending_assignment`.
   - A user who is `active` but has no active assignment row is treated the same way (AU-10).
   - A `suspended` or `disabled` user is refused at the next request, because the guard re-reads the status every request (cached for at most 60 s).
6. **Step-up.**
   - Operations marked `x-step-up: true` in the contract need `session.stepup_at` to be no older than `stepup_max_age_seconds` (setting, default 300 s).
   - Otherwise the API answers 401 with `code = step_up_required` and a `step_up_url`.
   - The client opens that URL. The API redirects to Entra with `prompt=login` and `max_age=0`, plus the Conditional Access authentication context (`claims` with `acrs`) once IT defines one.
   - On return, the API checks that the new ID token has the same `oid`, that `auth_time` is no older than 120 s, and the `amr` rule from item 3. Only then does it set `stepup_at`.
   - The audit row of the protected action records `stepup_verified = true`.
   - A bulk action (one approval of N tasks) needs one step-up for the whole request.
   - Fallback if the tenant does not emit `auth_time`: use the `iat` of the ID token returned by the forced `prompt=login` request. The P1 spike confirms which one applies.
7. **Break-glass account.**
   - One local account (`users.is_break_glass = true`) signs in with username, a password hashed with argon2id, and TOTP (RFC 6238, secret encrypted at rest with a key from the server environment).
   - `POST /auth/break-glass` is accepted only when the client IP, taken from the trusted proxy hop only, is inside `internal_cidrs` (setting).
   - Every attempt, successful or not, writes a System Log entry. A successful sign-in also writes an audit row with `privileged = true` and sends an email to every System Admin.
   - The session lasts at most 60 minutes. Step-up means entering TOTP again.
   - The account has System Admin rights but does **not** count toward the "at least one active admin" rule (ADR 0003).
   - After 5 failures the account is locked for 15 minutes.
8. **Future mobile app.** It will use MSAL as a public client and send bearer access tokens for a separate API scope. The contract already declares a `bearerAuth` scheme, which is not enabled in v0.1. The `amr`, tenant and step-up rules are the same.
9. **Logout.** Logout deletes the Redis session. Single sign-out from Entra is optional: the user can be sent on to the Entra logout URL.

## Consequences
- The web app needs no token handling. CSRF protection is mandatory and is tested.
- Redis becomes part of the authentication path. If Redis is lost, everyone is signed out, but no data is lost. Redis persistence is AOF.
- Step-up costs one full Entra round trip. A 5-minute window keeps bulk approval usable.
- The Entra app registration (redirect URIs `/api/v1/auth/callback` and `/api/v1/auth/step-up/callback`, and the `openid profile email` scopes) must be done by the M365 admin (ORCHESTRATION.md, "needs humans").
- Without an HR directory, a typo in an employee ID is caught only by the admin at assignment time.
