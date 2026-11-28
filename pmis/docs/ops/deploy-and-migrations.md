# Deploy, update and migration recovery

Nobody deploys without the owner's permission. This page is for the person who has it.

## 1. Update a server

The server is updated with one command, run as root from inside the repository checkout:

```bash
sudo bash pmis/tools/install/update.sh
```

What it does, in order (`pmis/tools/install/update.sh`, then `install-ubuntu.sh --update`):

1. `git pull --ff-only` on the branch that is checked out. It stops if the branch cannot fast-forward.
2. Raises the nginx read timeout if it is lower than 300 seconds (nginx is tested first, and the old file is put back if the test fails).
3. Gives the document store back to the service user if something in it is owned by another user.
4. Runs the installer in update mode: applies every migration that is not recorded yet, refreshes the application role grants (`pmis/db/sql/app_grants.sql`), rebuilds the API and the web app, restarts the API service and reloads nginx.
5. Writes a row in the deployment log (version, git commit, the migrations of this run, who ran it and where). Admins read it at `GET /admin/deployments`.

Data and settings (`/etc/gsdn-pmis/pmis.env`, `install.conf`) are kept. The installer needs no answers on update.

Before you run it: take a database backup (`pmis/infra/RUNBOOK.md` section 8) and read the newest CHANGELOG entries for anything marked as needing a manual step.

## 2. How migrations are applied

The installer reads `pmis/apps/api/prisma/migrations/0*/migration.sql` in name order. For each one that is not in `pmis_admin.migrations` it runs one transaction: `BEGIN`, the migration, the insert of its name into `pmis_admin.migrations`, `COMMIT`. The script runs `psql` with `ON_ERROR_STOP`, so the first error stops the update. The record and the migration commit together or not at all. `pmis_admin` is outside the `public` schema, so the application role cannot see it. The full picture, including the mirror files in `pmis/db/sql`, is in `pmis/db/README.md`.

## 3. A migration failed

Symptom: `update.sh` stops with a `psql` error and names the migration (a line with its number is the last one printed before the error).

What the state is: because each migration and its record are one transaction, a failed migration leaves **no change and no record**. The database is as it was before that migration. The API service is not restarted by a failed update, so the old version keeps running on the old schema.

Do this, in order:

1. Do not edit the database by hand and do not delete data. Copy the error text and the migration name.
2. Confirm the state (as the postgres user, with the right port and database name from `install.conf`):

   ```bash
   sudo -u postgres psql -d <database> -c "SELECT name, applied_at FROM pmis_admin.migrations ORDER BY name DESC LIMIT 5"
   ```

   The failed migration must not be in the list.
3. Fix it in the repository with a new pull request (a corrected migration is a new, additive migration or a corrected file that never reached a server). Never edit a migration that is already recorded on any server.
4. Run `update.sh` again. It continues from the first unrecorded migration.

### A migration was applied by hand and marked as applied

If someone ran a migration by hand and inserted its name into `pmis_admin.migrations` to make the installer skip it, but the migration did not really finish (for example it stopped half way outside a transaction), the installer will never run it again. To put the record right:

1. Find out what the migration really changed. Compare with the file. Do not guess.
2. Remove only the wrong record, as the postgres user:

   ```bash
   sudo -u postgres psql -d <database> -c "DELETE FROM pmis_admin.migrations WHERE name = '<migration name>'"
   ```

   This deletes the record of the migration, not data. It is the one case where deleting a row there is right, and it needs the owner's permission.
3. Put the database back to the state before the migration if it is half done (restore from the backup of section 1, or undo by hand with a reviewed script), then run `update.sh`. The installer applies the migration again, this time as one transaction.

Never delete a row of `pmis_admin.migrations` for a migration that finished correctly: the installer would run it a second time.

## 4. Walkthrough: a normal update

1. Ask the owner for permission and for a time. Tell the users.
2. Backup (section 1 of this page).
3. On the server: `cd` into the checkout, `git status` shows a clean tree on the expected branch.
4. `sudo bash pmis/tools/install/update.sh`. Read the migration names it prints.
5. When it ends, check the API: the service is active, and `GET /health` answers (see `pmis/infra/RUNBOOK.md`).
6. Sign in, open the Site Master list and one register. Check `GET /admin/deployments` shows the new commit and migrations.
7. If something is wrong, do not roll the code back by hand. Report it with the log; a rollback of the database means restoring the backup of step 2 together with the previous commit, and the owner decides.

## Migration 0700: log line of the scenario-rule probe (diagnostic)

`site_new_clean` checks the scope flags against the scenario rules with a probe site that is rolled back. When that probe fails for any reason the person sees "The site could not be checked against the scenario rules." Since 0700 the database log also gets one line, `site_new_clean probe failed: sqlstate <code> message <text>`. Nothing else changes: same answer, same rows, same rights. Search the log for that text when a row of a New sites batch is refused with that message.
