# Contributing

The system lives in `pmis/`. The binding rules are in [`pmis/CLAUDE.md`](pmis/CLAUDE.md), the current state is in [`pmis/HANDOVER.md`](pmis/HANDOVER.md), and the reason for every change is in [`pmis/CHANGELOG.md`](pmis/CHANGELOG.md). Read those three first. This file only lists what a pull request must do.

## Before you start

- Work on a branch and open a pull request to `main`. Keep it small and focused.
- **Contract first.** An endpoint, a field or an error code is added to `pmis/contracts/openapi.yaml` before the code that uses it. Add a line to the Versions list and set the version at the top of the file.
- Use the term **Site Master** only.
- Test data is synthetic. Never commit a secret, a real person's data or a real server address.

## What every pull request carries

1. **CHANGELOG entry.** A new entry at the top of `pmis/CHANGELOG.md`. It says what changed, why, and every choice made.
2. **Tests.** New behaviour has tests. Run the commands in [`pmis/infra/README.md`](pmis/infra/README.md) for the API and the web app.
3. **Migrations.** Migrations are additive and numbered in order (`pmis/apps/api/prisma/migrations/NNNN_name`). The number is unique across `main` and every open pull request. A file in `pmis/db/sql` that mirrors a migration is numbered one less and is identical to it, byte for byte.
4. **New table.** A new table also gets its data-reset steps: a decision in `data_reset_plan`, the grants of `pmis_reset_owner`, and a row in `pmis/docs/ops/data-reset.md`. A migration never rebuilds an accumulating SQL function (`dashboard_settings_catalogue`, `data_reset_parts`, `data_reset_register_part`) from an old body: it patches the stored text, or it carries every part added by earlier migrations.
5. **Permissions.** Permissions come from the responsibility matrix, never from code. A new register gets its matrix rows. A pull request does not widen a permission, a role, a grant or a default value unless that is its stated purpose.
6. **Whole coverage.** A feature covers every register and screen where it belongs, and has its Settings. The pull request lists each place covered and any place left out, with the reason.
7. **Both languages.** New text has keys in `en.json` and `ar.json`.
8. **Contract and types.** `npm run gen:api` (in `pmis/apps/web`) leaves no change in `src/api/schema.d.ts`.
9. **Changing a SQL function.** Patch the stored text of the function with a marker, never rebuild it from an old body. See [`pmis/db/README.md`](pmis/db/README.md).
10. **Dependencies.** A new package needs a license on the allowlist and a refreshed `pmis/THIRD_PARTY_NOTICES.md` ([`pmis/docs/ops/licenses.md`](pmis/docs/ops/licenses.md)).

## Deploy and recovery

Updating a server and recovering from a failed migration are in [`pmis/docs/ops/deploy-and-migrations.md`](pmis/docs/ops/deploy-and-migrations.md). Nobody deploys without the owner's permission.

## CI

Eight checks must pass before a merge: Installer scripts, OpenAPI lint, API tests, SAST, Dependencies, Web, IaC and Secrets. How to run each one locally is in [`pmis/infra/README.md`](pmis/infra/README.md).

## Reporting a problem

Bugs and feature requests use the issue templates. A security problem does not go in an issue: see [`SECURITY.md`](SECURITY.md).
