# GSDN PMIS web (phase 1)

React 18, TypeScript, Vite, Tailwind (tokens from `design/tokens.css`), TanStack Query, react-router, react-i18next (EN + AR, RTL by `dir` + logical CSS only). Auth is the backend-for-frontend session cookie (ADR 0002): no MSAL and no tokens in the browser.

Phase 1 screens: app shell (sidebar by `effective.nav`, Ctrl+K palette, language, theme, notifications), one-box login, first-sign-in employee ID, pending assignment, My Work, Approvals (drawer pane, approve/pass/return with note, bulk with one step-up), employee hover card (`PersonTag`).

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

Mock sign-in: the login page sends you to a fake Microsoft page with four accounts (PM final approver, Team Lead reviewer, first sign-in, pending). Mock state lives in `localStorage` key `pmis-mock-db`; clear it to reset.

## Swap the mocks for the real API

One env var: set `VITE_USE_MOCKS=false` (for example in `.env.production`, already the default for builds). Then the browser talks to `VITE_API_BASE_URL` (default `/api/v1`, same origin behind the BFF proxy so the `pmis_session` cookie is sent with `credentials: 'include'`). Nothing else changes. `VITE_USE_MOCKS=true` is the only thing that starts MSW.

## Layout

- `src/api/client.ts` typed fetch: problem+json to `ApiError`, `If-Match`, `X-CSRF-Token`, `Idempotency-Key`, and 401 `step_up_required` handling (one shared step-up, then one retry). `src/api/schema.d.ts` is generated.
- `src/mocks/` handlers for the endpoints phase 1 uses, data from `design/prototype-v2/data.js` style sites and `db/seed/staff-registry.draft.csv`. `GET /auth/login` answers the same shape for any identifier and only echoes `login_hint` when the user typed an email.
- `src/i18n/{en,ar}.json` all strings. Lint bans physical direction classes (`ml-`, `pr-`, `left-`, `text-right` and so on).
- `e2e/` Playwright: login, My Work, approve with step-up in EN and AR.

Stable `data-testid` hooks are in the components (`login-identifier`, `my-work-bucket-*`, `approval-row-<id>`, `approval-approve`, `bulk-approve`, `stepup-dialog`, `person-id-<employee_id>`, `staff-card`, `toast`, ...).
