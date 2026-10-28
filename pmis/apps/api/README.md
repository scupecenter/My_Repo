# GSDN PMIS API

NestJS 11, TypeScript strict, Prisma 6 client, PostgreSQL 16. Built so far: local sign-in (ADR 0012), `/me`, users and groups
administration. Contract: `../../contracts/openapi.yaml` (0.3.0). Every route not in that list answers problem+json 404 `not_found`.

## Commands (Node 22, npm)

```
npm ci                 # installs and generates the Prisma client (postinstall)
npm run build          # prisma generate + tsc -> dist/
npm run start          # node dist/main.js   (needs the environment below)
npm run dev            # tsx watch, reads ./.env when present
npm run typecheck
npm run lint           # also bans $queryRawUnsafe / $executeRawUnsafe in src (ADR 0003)
npm test               # needs a local PostgreSQL 16, see below
printf '%s' "$PASSWORD" | node dist/cli.js hash-password   # argon2id PHC hash for idm_bootstrap_admin (installer)
```

## Environment (see `.env.example`)

`DATABASE_URL` (role `pmis_app`), `PORT` (3000), `HOST` (127.0.0.1), `COOKIE_SECURE` (true; `false` only for plain-http development),
`LOG_HMAC_KEY` (>= 16 characters), `NODE_ENV`. Nothing else is read.

## Tests

`test/global-setup.ts` creates two fresh databases (`pmis_api_test` and `pmis_api_test_solo`, names overridable with `TEST_DB_NAME`),
applies `prisma/migrations/0*/migration.sql` as the superuser, then `../../db/sql/app_grants.sql`, seeds the 7 regions, bootstraps an
admin with `idm_bootstrap_admin`, and drops both afterwards (`TEST_KEEP_DB=1` keeps them). The API under test connects as `pmis_app`.

```
TEST_PG_ADMIN_URL=postgresql://postgres:<superuser password>@127.0.0.1:5432/postgres \
TEST_PG_APP_PASSWORD=<password of the role pmis_app> \
npm test
```

## How a request runs

1. `SessionGuard`: cookie `pmis_session` -> `user_sessions` (SHA-256 of the token), idle 8 h / absolute 12 h / revoked, user status,
   sliding touch (not for `X-PMIS-Live: 1`), CSRF on unsafe methods, then the gates `password_change_required` and `pending_assignment`.
2. `TxInterceptor`: one transaction per request; first statements are `set_config('app.user_id')` and `set_config('app.region_ids')`.
3. Handlers call the database functions (`idm_*`, `auth_local_*`); the API never writes identity tables itself.
4. `ProblemFilter` turns every error into application/problem+json with `request_id`.
