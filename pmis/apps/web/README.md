# GSDN PMIS web (phase 1)

React 18, TypeScript, Vite, Tailwind (tokens from `design/tokens.css`), TanStack Query, react-router, react-i18next (EN + AR, RTL by `dir` + logical CSS only). Auth is the backend-for-frontend session cookie (ADR 0002): no MSAL and no tokens in the browser. Sign-in is a local PMIS account now (ADR 0012); Microsoft 365 stays in the code behind `VITE_M365_ENABLED`.

Phase 1 screens: app shell (sidebar by `effective.nav`, Ctrl+K palette, language, theme, notifications), one-box login (identifier + password), change password (forced after a temporary one, voluntary from the user menu), step-up by password, New user and Reset password with a show-once temporary password (Users & Roles), first-sign-in employee ID, pending assignment, My Work, Approvals (drawer pane, approve/pass/return with note, bulk with one step-up), employee hover card (`PersonTag`).

## Run

```bash
npm ci
npm run dev          # http://localhost:5173, MSW mocks ON (VITE_USE_MOCKS=true from .env.development)
npm run build        # tsc + vite build into dist/ (mocks are not bundled)
npm test             # Vitest + Testing Library + MSW node server
npm run typecheck && npm run lint
npm run e2e          # Playwright (starts vite on :5174 with mocks); uses /opt/pw-browsers/chromium, override with PW_CHROMIUM_PATH
SHOTS=1 npx playwright test e2e/screenshots.spec.ts   # regenerates design/screens/app/*.png
npm run gen:api      # regenerates src/api/schema.d.ts from ../../contracts/openapi.yaml
```

## Run modes

| Mode | Env | What talks to what |
|---|---|---|
| Mocks (default for `npm run dev`) | `VITE_USE_MOCKS=true` | Everything is answered by MSW in the browser. |
| Hybrid | `VITE_USE_MOCKS=true` `VITE_REAL_API=auth-users` | Sign-in, session, `/me`, users and groups go to the real server; every other screen keeps sample data. |
| Real | `VITE_USE_MOCKS=false` | Everything goes to `VITE_API_BASE_URL` (default `/api/v1`). Builds default to this. |

Hybrid details:
- The exact method + path patterns that pass through are in one file, `src/mocks/realApi.ts` (`POST /auth/local/login`, `POST /auth/local/password`, `POST /auth/local/step-up`, `GET /auth/session`, `POST /auth/logout`, `GET /me`, `GET /users`, `POST /users`, `GET /users/:id`, `PATCH /users/:id`, `POST /users/:id/password-reset`, `GET /groups`, `GET /groups/:id`, `POST /groups/:id/members`, `DELETE /groups/:id/members/:userId`, and the contract 0.4.0 operations: `GET/POST /departments`, `PATCH /departments/:id`, `PUT /users/:id/org`, `/messages/...`, `/announcements/...`, `GET /me/announcements/pending`). Anything else, for example `/users/:id/assignments`, stays mocked. `GET /users/deleted` and `GET /users/picker` stay mocked too, so the `:id` pattern does not swallow them. MSW uses `passthrough()`.
- While the real session is authenticated, the mock session is the demo Project Manager so the mocked screens work (`src/mocks/hybrid.ts`); signing out clears it. Mocked screens that ask for step-up are not asked twice.
- A slim banner (EN/AR) says that other screens show sample data.
- The service worker file stays in the build, so build with the flags: `VITE_USE_MOCKS=true VITE_REAL_API=auth-users npm run build`.
- `npm run dev` with `VITE_PROXY_TARGET=https://<server>` forwards `/api` to that server (Vite dev proxy).
- To end hybrid mode when the API is complete, set `VITE_USE_MOCKS=false`; the list in `realApi.ts` is only for the transition.

### Mock sign-in (synthetic demo accounts)

Type the employee ID, email or phone in the one box, plus the password. The mock follows the contract rules (ADR 0012): the same 401 `invalid_credentials` for an unknown identifier, a wrong password, a locked account and a switched-off account; 5 failures lock the account for 15 minutes; more than 10 attempts per minute answer 429; a temporary password forces the change-password screen (403 `password_change_required` elsewhere); 422 `weak_password`, 409 `duplicate` and the show-once temporary password work like the API.

| Account | Identifier (any of) | Demo password | Notes |
|---|---|---|---|
| Project Manager (System Admin) | `1001`, `ahmed.salem@example.com`, `+218 91 200 1000` | `Demo-Pm-2026-pass` | final approver, all admin screens |
| Team Lead (reviewer) | `1102`, `mona.fathi@example.com` | `Demo-Lead-2026-pass` | |
| Security auditor | `1103`, `ali.barka@example.com` | `Demo-Audit-2026-pass` | sees the security log |
| Staff engineer | `1204`, `sami.nuri@example.com` | `Demo-Staff-2026-pass` | has one unanswered announcement in the seed, so the blocking pop-up shows after sign-in (e2e helper `answerAnnouncements`) |
| Pending assignment | `1211`, `wael.saadi@example.com` | `Demo-Pending-2026-pass` | sees the pending screen |
| First sign-in | `new.employee@example.com` | `Demo-First-2026-pass` | must change the password, then enters the employee ID |

These are synthetic and exist only in the mock layer (a normal production build does not contain them; a hybrid build does). Users created in the mock get a temporary password shown once. Mock state lives in `localStorage` key `pmis-mock-db`; clear it to reset. The old fake Microsoft page (`/mock-m365`) is still in the code and is reached only through the hidden Microsoft 365 button (`VITE_M365_ENABLED=true`).

## Layout

- `src/api/client.ts` typed fetch: problem+json to `ApiError`, `If-Match`, `X-CSRF-Token`, `Idempotency-Key`, and 401 `step_up_required` handling (one shared step-up, then one retry). `src/api/schema.d.ts` is generated.
- `src/mocks/` handlers for the endpoints phase 1 uses, data from `design/prototype-v2/data.js` style sites and `db/seed/staff-registry.draft.csv`. `POST /auth/local/login` answers the same 401 for every failure (`src/mocks/handlers.auth.ts`); the Microsoft path `GET /auth/login` answers the same shape for any identifier and only echoes `login_hint` when the user typed an email.
- `src/i18n/{en,ar}.json` all strings. Lint bans physical direction classes (`ml-`, `pr-`, `left-`, `text-right` and so on).
- `e2e/` Playwright: login errors, My Work, approve with step-up by password, create user + first sign-in change, in EN and AR. `e2e/helpers.ts` has `login(page, account)` and `stepUp(page)`.

Stable `data-testid` hooks are in the components (`login-identifier`, `login-password`, `login-submit`, `login-error`, `login-m365`, `cp-current`, `cp-new`, `cp-confirm`, `cp-submit`, `change-password-forced`, `stepup-password`, `stepup-error`, `users-new`, `new-user-*`, `temp-password`, `temp-password-copy`, `temp-password-done`, `user-reset-password`, `local-badge-<id>`, `must-change-badge-<id>`, `user-menu-change-password`, `hybrid-banner`, `my-work-bucket-*`, `approval-row-<id>`, `approval-approve`, `bulk-approve`, `stepup-dialog`, `person-id-<employee_id>`, `staff-card`, `toast`, ...).

## Messages, announcements, departments (contract 0.4.0, ADR 0013)

- `/messages`, `/messages/:threadId` (sidebar Messages with an unread badge polled every 60 s with `X-PMIS-Live`): my threads, the original message first, a reply box directly under it, then the replies newest first. Opening a thread calls `POST .../read`. Replies are optimistic and roll back with the text on failure.
- `/admin/announcements`, `/admin/announcements/:id` (sidebar Announcements when `effective.nav` has `announcements`): send to everyone or a mix of users, groups, roles and departments; results with counts, a decision filter and Excel (CSV) export.
- The blocking pop-up (`components/AnnouncementPopup.tsx`) is mounted in the signed-in gate (`App.tsx`), so pending and must-change accounts get it too. It polls `GET /me/announcements/pending` every 60 s and cannot be closed.
- Users & Roles: a Departments sub-tab under Users (beside Deleted and Online now), a Department column, and manager and department with an edit dialog on the user page.
- Mock seed: manager chain (everyone up to the Project Manager) and departments; three threads; one sent announcement that only the staff engineer account (1204) and 1310 have not answered. Only 1204 can sign in, so the e2e suite is not blocked by the pop-up for the PM, reviewer or auditor accounts.
- Stable test ids: `nav-messages`, `messages-badge`, `thread-<id>`, `thread-unread-<id>`, `msg-original`, `reply-box`, `reply-body`, `reply-send`, `reply-list`, `messages-new`, `new-message-*`, `nav-announcements`, `ann-new-open`, `ann-title`, `ann-body`, `ann-all`, `ann-warning`, `ann-new-submit`, `ann-row-<id>`, `ann-count-<id>-<kind>`, `ann-popup`, `ann-popup-agree|disagree|note|submit`, `ann-stat-*`, `ann-filter`, `ann-resp-<employee_id>`, `ann-export`, `users-tab-departments`, `dept-*`, `org-edit`, `org-dialog*`, `org-manager-value`, `org-department-value`, `user-dept-<employee_id>`.
