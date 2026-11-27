# S4: passkeys (WebAuthn) as an optional second step - design (draft)

Status: design only. No code in this PR yet. Reserved numbers: migration 0294+, contract 0.15.194+ (re-check live before the first code push).

## Goals and hard rules
- Opt-in and off by default. A System Admin enables it in Settings > Security (setting `security.passkeys`). Nothing changes for anyone until then.
- Never forced. A user registers a passkey only from their own profile. No forced enrollment, no "enforce" switch in this slice.
- No lockout. Passkeys are an additional way to satisfy the second step, never the only way. Password, existing TOTP two-factor and its backup codes keep working. Admin can remove any user's passkeys (audited), and the System Admin recovery path of S3 is untouched.
- Existing sessions and logins unchanged. No existing permission widened. No data deleted.
- No secrets in plain text: only public keys, credential ids and sign counters are stored. Challenges are random, single-use, expire in 5 minutes, and are stored hashed.
- Rate limits and an audit row on every action (register, remove, sign-in success and failure, setting change). security_log reuses existing event names with a detail field (closed CHECK set).
- Real enforcement in the database: the sign-in door (`auth_session_create`) keeps the pass-row model of S3. A passkey assertion creates the same kind of pass row, verified server-side.

## Dependency approach
Neither `@simplewebauthn/server` nor any WebAuthn package is installed. Proposal: no new dependency. Verify with `node:crypto` only, supporting the two algorithms every platform authenticator offers (ES256, RS256), attestation `none` (we do not validate attestation statements: we only need the public key), user-presence and user-verification flags required, origin and rpId checked against server config (`APP_CONFIG`), sign counter checked for rollback. This keeps the supply chain unchanged and the verifier small enough to test fully with vectors. Alternative if Ahmed prefers a library: add `@simplewebauthn/server` (adds a dependency and a lockfile change). Default is the no-dependency path.

## Data model (new tables must be classified KEEP in data_reset_plan() by an in-place patch, plus GRANT SELECT, UPDATE to pmis_reset_owner)
- `user_passkeys`(id, user_id, credential_id unique, public_key, alg, sign_count, transports, label, created_at, last_used_at, revoked_at, revoked_by). Rows are revoked, never deleted.
- `passkey_challenges`(id, user_id nullable, purpose register|authenticate, challenge_hash, expires_at, used_at).
- RLS and security-definer doors like 0290-0293: `passkey_register_begin/finish`, `passkey_auth_begin/finish`, `passkey_revoke`, `admin_passkey_revoke(user, reason)`.

## API and UI
- `GET/PUT /settings/passkeys` (admin, step-up, If-Match). `GET /me/passkeys`, register begin/finish, rename, revoke (own, step-up). `POST /auth/local/passkey/options|verify` as a second-step alternative beside TOTP. `DELETE /users/{id}/passkeys` (admin, reason, audited).
- Web: Settings > Security card; profile section "Passkeys" (add, name, remove); a "Use a passkey" button on the second-step screen, only when enabled for that account. Arabic RTL and English.

## Self-review: lockout paths
1. Lost device: password plus TOTP or backup codes still work; if none, an admin removes the passkey (audited) and the user signs in as before. Passkeys never replace the password.
2. Admin disables the setting: passkey sign-in stops being offered, nothing else changes, rows are kept, and re-enabling restores them.
3. Last credential removal: always allowed, since passkeys are optional. If a user has no other second step and the admin has enforced two-step (existing feature), removal is refused while a passkey is the only step, to avoid a silent downgrade to none.
4. System Admins stay reachable through the S3 recovery path.

## Self-review: downgrade paths
1. An attacker cannot choose a weaker step: when a user has a passkey, sign-in offers it, but the TOTP path stays the same strength it is today, so there is no new weaker path. Passkey registration needs step-up (password) so a stolen session cannot silently add a credential.
2. Sign counter rollback or credential reuse across accounts is rejected and logged.
3. Challenge replay: single use, 5 minutes, bound to user and purpose.
4. Origin or rpId mismatch fails closed. Misconfigured rpId disables the feature rather than accepting any origin.
5. Admin revoke and user revoke are both audited, and revocation takes effect on the next sign-in; existing sessions are not killed (unchanged rule).

## S3 coverage list (places the second step applies, from the S3 sign-in work)
Local password sign-in second step (same door as TOTP) is the only place a passkey applies. Covered: local sign-in, new-device code flow interplay (passkey satisfies the second step, new-device code stays a separate gate). Excluded with reason: M365 (SSO) sessions, because identity and MFA are owned by Microsoft; API tokens and service accounts, because they have no interactive step; step-up re-auth, which stays password-based in this slice to avoid widening what satisfies it.

## Plan
1. This design (draft PR). 2. Verifier plus tests with vectors. 3. DB doors and migration. 4. API. 5. Web. 6. Full tests, coverage checklist, mark ready.
