# CI: what runs and how to reproduce it locally

The workflow is `.github/workflows/ci.yml` at the repository root. It runs on pull requests to `main` and on pushes to `main`. Each job below maps to a set of commands you can run from a checkout.

| Job | Runs | Local reproduction |
|---|---|---|
| `api` | Node 22, PostgreSQL 16 service container. Creates role `pmis_app`, then `npm ci`, typecheck, lint, build, test | See "API" below |
| `web` | Node 22. `npm ci`, typecheck, lint, unit tests, build, Playwright e2e (Chromium) | See "Web" below |
| `contract` | `npx @redocly/cli@1 lint contracts/openapi.yaml`, fails on errors only | `cd pmis && npx -y @redocly/cli@1 lint contracts/openapi.yaml --config contracts/redocly.yaml` |
| `installer` | `bash -n` and `shellcheck --severity=error` on the installer and update scripts | `cd pmis && bash -n tools/install/install-ubuntu.sh tools/install/update.sh && shellcheck --severity=error tools/install/install-ubuntu.sh tools/install/update.sh` |

The PostgreSQL passwords in the workflow are CI-only test values for a service container that lives for one job. They are not secrets and must not be reused anywhere else. Real values come from the environment or a vault and are never committed.

## API

The API tests need a PostgreSQL 16 server reachable with a superuser URL and a password for the role `pmis_app`. `test/global-setup.ts` creates two throw-away databases, applies `prisma/migrations/0*/migration.sql` in order and `db/sql/app_grants.sql`, then runs the suites as `pmis_app`.

```bash
cd pmis/apps/api
export TEST_PG_ADMIN_URL=postgresql://postgres:<superuser-password>@127.0.0.1:5432/postgres
export TEST_PG_APP_PASSWORD=<pmis_app-password>
npm ci
npm run typecheck && npm run lint && npm run build && npm test
```

If `pmis_app` already exists, its password is not changed by the test setup, so `TEST_PG_APP_PASSWORD` must match the existing one.

## Web

```bash
cd pmis/apps/web
npm ci
npm run typecheck && npm run lint && npm test && npm run build
npx playwright install chromium          # or set PW_CHROMIUM_PATH to an existing Chromium
npm run e2e
```

`playwright.config.ts` uses `PW_CHROMIUM_PATH` when it is set, and otherwise falls back to `/opt/pw-browsers/chromium`. CI sets `PW_CHROMIUM_PATH` to the browser that `playwright install` downloads. The e2e suite runs against the in-browser mock layer, so no API or database is needed. Screenshot specs are skipped unless `SHOTS=1` is set. Playwright writes `playwright-report/` and `test-results/` on failure, and CI uploads them as the `playwright-report` artifact.

## Contract and installer

Run the two commands in the table above from the `pmis/` directory. The OpenAPI lint currently reports 4 warnings and no errors. Warnings do not fail the job.

## Known differences from GitHub's runners

- The API job uses `ubuntu-24.04` with the `postgres:16` service container on `127.0.0.1:5432`. A local PostgreSQL 16 install reproduces this, but CI always starts from an empty server, so the `pmis_app` role is created by the workflow there.
- Local machines may already have `/opt/pw-browsers/chromium`. CI does not, and uses the browser it downloads.
- `npx playwright install --with-deps` needs `sudo` and installs system libraries. Locally, run it only if you do not already have Chromium.
- The CI job timeouts are 30 minutes for `api` and `web`, and 10 minutes for `contract` and `installer`.
