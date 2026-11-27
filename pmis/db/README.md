# Database: how migrations work

There are two places where SQL lives, and they are kept the same on purpose.

## 1. `apps/api/prisma/migrations/NNNN_name/migration.sql` (the source that runs)

- This is what a server applies. The installer (`tools/install/install-ubuntu.sh`, also used by `update.sh`) runs each folder in name order, each one in a transaction together with its row in `pmis_admin.migrations`. See `docs/ops/deploy-and-migrations.md`.
- The tests use the same folders: `apps/api/test/global-setup.ts` creates an empty database and applies every migration in order, then `db/sql/app_grants.sql`. The API job of CI therefore replays the whole history on an empty database on every pull request.
- Migrations are additive. A recorded migration is never edited.
- The number is unique across `main` and every open pull request. Check both before you take one.

## 2. `db/sql/` (the readable mirror, and the deployment grants)

- Each migration that carries SQL also has a mirror file here, numbered **one less** than the migration (migration `0380_invoices_relation` is `db/sql/379_invoices_relation.sql`). The mirror is **byte-identical** to the migration. The review checks this with `cmp` (some mirrors also have a test).
- The mirror exists so a reviewer or a database engineer can read and run the SQL without the Prisma folder layout.
- `db/sql/app_grants.sql` is not a mirror. It is the deployment step that narrows the application role `pmis_app`, and the installer runs it after every migration run.

## Rules for a change

1. New migration folder and its mirror together, identical, numbers as above.
2. A new table: a decision in `data_reset_plan`, grants for `pmis_reset_owner`, a row in `docs/ops/data-reset.md`.
3. **Changing an existing SQL function.** Some functions grow over many migrations (for example the Settings catalogue, the data-reset functions). Never copy an old body into `CREATE OR REPLACE`: it silently drops the parts added later. Patch the stored text instead:
   - read it with `pg_get_functiondef('schema.name(args)'::regprocedure)`;
   - change it with `replace()` or `regexp_replace()` on a fixed anchor (a marker line);
   - do it only when the change is not there yet, so running it twice changes nothing;
   - raise an exception when the anchor is not found, so a wrong assumption fails loudly;
   - run the result with `EXECUTE`.
   Example: `0380_invoices_relation`.
4. No change to a permission, a role, a grant or a default value unless that is the stated purpose of the pull request.
5. Test the migration on an empty database (CI does) and, when it rewrites rows, on a copy of real data.

## If a migration fails on a server

See `docs/ops/deploy-and-migrations.md`, section 3.
