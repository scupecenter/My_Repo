import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import * as argon2 from 'argon2';

/**
 * Test database setup (runs once before the suites):
 *   1. creates a fresh database (default pmis_api_test) as the superuser,
 *   2. applies prisma/migrations/0*\/migration.sql in order,
 *   3. applies db/sql/app_grants.sql (the deployment step that narrows pmis_app),
 *   4. bootstraps the first System Admin with idm_bootstrap_admin (as the installer does),
 *   5. hands the suites a DATABASE_URL that connects as pmis_app, never as the superuser.
 *
 * Needs, in the environment:
 *   TEST_PG_ADMIN_URL      superuser URL of the server (container-only credentials), e.g. postgresql://postgres:...@127.0.0.1:5432/postgres
 *   TEST_PG_APP_PASSWORD   password of the existing database role pmis_app (created with it when it does not exist)
 *   TEST_DB_NAME           optional, default pmis_api_test
 */
export const BOOTSTRAP_ADMIN = {
  email: 'bootstrap.admin@example.test',
  name: 'Bootstrap Admin',
  employeeId: '9001',
  phone: '+218910000001',
  password: 'Bootstrap-Admin-Pass-2026',
};

/** 32 bytes as hex, test only. Loaded into pmis_context_keys of every test database; the API signs its contexts with the same key (testConfig in helpers.ts). */
export const TEST_CONTEXT_KEY = '5a1ec0de5e55105c0de7e57a11c0de5e55105c0de7e57a11c0de5e55105c0de7';

const API_ROOT = resolve(__dirname, '..');
const REPO_PMIS = resolve(API_ROOT, '..', '..');

async function buildDatabase(adminUrl: string, dbName: string, appPassword: string, withLibrary = false): Promise<{ appUrl: string; superUrl: string }> {
  if (!/^[a-z][a-z0-9_]{2,40}$/.test(dbName)) throw new Error('TEST_DB_NAME must be a simple lower-case identifier');
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  const role = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app'");
  if (role.rowCount === 0) {
    await admin.query(`CREATE ROLE pmis_app LOGIN PASSWORD '${appPassword.replace(/'/g, "''")}'`);
  }
  await admin.end();

  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  const superUrl = u.toString();
  const db = new Client({ connectionString: superUrl });
  await db.connect();

  const migrationsDir = join(API_ROOT, 'prisma', 'migrations');
  const dirs = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^0/.test(d.name))
    .map((d) => d.name)
    .sort();
  for (const d of dirs) {
    try {
      await db.query(readFileSync(join(migrationsDir, d, 'migration.sql'), 'utf8'));
    } catch (e) {
      throw new Error(`migration ${d} failed: ${(e as Error).message}`);
    }
  }
  await db.query(readFileSync(join(REPO_PMIS, 'db', 'sql', 'app_grants.sql'), 'utf8'));
  // The 7 regions are seed data (CLAUDE.md). Migration 0013 seeds them; this insert keeps the suites working on a database built without it.
  await db.query(`INSERT INTO regions (id, code, name_en) VALUES (1,'TRIPOLI','Tripoli'),(2,'MIDDLE','Middle'),(3,'WM','WM'),(4,'ZAWIA','Zawia'),
    (5,'BENGHAZI','Benghazi'),(6,'GM','GM'),(7,'SEBHA','Sebha') ON CONFLICT (id) DO NOTHING`);

  // Cheap parameters: the test hashes only have to be valid argon2id PHC strings (the API verifies whatever the string says).
  const hash = await argon2.hash(BOOTSTRAP_ADMIN.password, { type: argon2.argon2id, memoryCost: 4096, timeCost: 2, parallelism: 1 });
  // Migration 0038 seeds the Document Library with mandatory documents on stages 1 to 3. The workflow suites of the other databases submit tasks without
  // documents, so the seeded library is switched off there (is_active false: no slot is built and nothing blocks Submit). The documents suites run on
  // their own database (TEST_DATABASE_URL_DOCS) with the library as the migration seeded it.
  if (!withLibrary) await db.query('UPDATE document_types SET is_active = false WHERE lib_managed');
  await db.query('SELECT app_ctx_key_install($1)', [TEST_CONTEXT_KEY]);
  await db.query('SELECT idm_bootstrap_admin($1, $2, $3, $4, $5)', [BOOTSTRAP_ADMIN.email, BOOTSTRAP_ADMIN.name, BOOTSTRAP_ADMIN.employeeId, BOOTSTRAP_ADMIN.phone, hash]);
  await db.end();

  const app = new URL(adminUrl);
  app.username = 'pmis_app';
  app.password = appPassword;
  app.pathname = `/${dbName}`;
  return { appUrl: app.toString(), superUrl };
}

export default async function setup(): Promise<() => Promise<void>> {
  const adminUrl = process.env.TEST_PG_ADMIN_URL;
  const appPassword = process.env.TEST_PG_APP_PASSWORD;
  if (!adminUrl || !appPassword) {
    throw new Error(
      'Set TEST_PG_ADMIN_URL (superuser URL of a local PostgreSQL 16) and TEST_PG_APP_PASSWORD (password of the role pmis_app) to run the tests.',
    );
  }
  const dbName = process.env.TEST_DB_NAME ?? 'pmis_api_test';
  // The second database holds exactly one System Admin, for the last-admin rule (the shared one has several).
  const solo = `${dbName}_solo`;
  const main = await buildDatabase(adminUrl, dbName, appPassword);
  const one = await buildDatabase(adminUrl, solo, appPassword);
  // The third database is for suites that change shared calculation settings (SLA versions, the default calendar): they must not touch what the other suites compute.
  const calc = `${dbName}_calc`;
  const third = await buildDatabase(adminUrl, calc, appPassword);
  // The fourth database is for the owner-answer suites of migration 0018 (gate lock, exempt list, DLP days, reminders, the daily job): they change
  // settings and holidays that the other calculation suites must not meet.
  const calc2 = `${dbName}_calc2`;
  const fourth = await buildDatabase(adminUrl, calc2, appPassword);
  // The fifth and sixth databases are for the dashboard (migration 0039): one with a small data set whose numbers are computed by hand, and one with 1000 synthetic
  // sites for the performance check. Both count every site they hold, so no other suite may write to them.
  const dash = `${dbName}_dash`;
  const dashPerf = `${dbName}_dashperf`;
  // dash2: the owner-answer suite of migration 0046 (manual Project Status values, delay periods, the snapshot schedule) changes the figures it reads.
  const dash2 = `${dbName}_dash2`;
  const [fifth, sixth, seventh] = await Promise.all([buildDatabase(adminUrl, dash, appPassword), buildDatabase(adminUrl, dashPerf, appPassword), buildDatabase(adminUrl, dash2, appPassword)]);
  // The docsDb database is for the document upload suites: the seeded Document Library stays active in it.
  const docs = `${dbName}_docs`;
  // The logs database (migration 0045): the suite breaks and restores a hash chain, changes the retention and the alert thresholds.
  const logs = `${dbName}_logs`;
  // The P9 databases (migration 0055): the logs suite changes the alert settings and breaks a chain; the mail suite counts the mails it queues.
  const p9 = `${dbName}_p9`;
  const p9m = `${dbName}_p9m`;
  const [docsDb, logsDb, p9Db, p9mDb] = await Promise.all([buildDatabase(adminUrl, docs, appPassword, true), buildDatabase(adminUrl, logs, appPassword),
    buildDatabase(adminUrl, p9, appPassword), buildDatabase(adminUrl, p9m, appPassword)]);
  process.env.TEST_DATABASE_URL_P9 = p9Db.appUrl;
  process.env.TEST_SUPER_URL_P9 = p9Db.superUrl;
  process.env.TEST_DATABASE_URL_P9M = p9mDb.appUrl;
  process.env.TEST_SUPER_URL_P9M = p9mDb.superUrl;
  // The P1 database (migration 0052): the scenario applicability suite changes the scenario rules, publishes SLA rule sets and adds tentative holidays.
  const p1 = `${dbName}_p1`;
  const p1Db = await buildDatabase(adminUrl, p1, appPassword);
  process.env.TEST_DATABASE_URL_P1 = p1Db.appUrl;
  process.env.TEST_SUPER_URL_P1 = p1Db.superUrl;
  // dashp2: the P2 suite of the owner answers of 2026-11-04 (migration 0059): delay proposals, plans, back-dating, the pipeline setting.
  const dashP2 = `${dbName}_dashp2`;
  const dashP2Db = await buildDatabase(adminUrl, dashP2, appPassword);
  process.env.TEST_DATABASE_URL_DASHP2 = dashP2Db.appUrl;
  process.env.TEST_SUPER_URL_DASHP2 = dashP2Db.superUrl;
  // The follow-up B database (migration 0067): the suite runs the daily job and the integrity check, sets the calendar confirmation and counts the mails it queues.
  const fb = `${dbName}_fb`;
  const fbDb = await buildDatabase(adminUrl, fb, appPassword);
  process.env.TEST_DATABASE_URL_FB = fbDb.appUrl;
  process.env.TEST_SUPER_URL_FB = fbDb.superUrl;
  // The settings-screens database (migration 0072): the suite confirms the calendar, sets the mail kinds and moves sites between regions (it counts notifications).
  const ss = `${dbName}_ss`;
  const ssDb = await buildDatabase(adminUrl, ss, appPassword);
  process.env.TEST_DATABASE_URL_SS = ssDb.appUrl;
  process.env.TEST_SUPER_URL_SS = ssDb.superUrl;
  process.env.TEST_DATABASE_URL_LOGS = logsDb.appUrl;
  process.env.TEST_SUPER_URL_LOGS = logsDb.superUrl;
  process.env.TEST_DATABASE_URL_DOCS = docsDb.appUrl;
  process.env.TEST_SUPER_URL_DOCS = docsDb.superUrl;
  process.env.TEST_DATABASE_URL = main.appUrl;
  process.env.TEST_SUPER_URL = main.superUrl;
  process.env.TEST_DATABASE_URL_SOLO = one.appUrl;
  process.env.TEST_SUPER_URL_SOLO = one.superUrl;
  process.env.TEST_DATABASE_URL_CALC = third.appUrl;
  process.env.TEST_SUPER_URL_CALC = third.superUrl;
  process.env.TEST_DATABASE_URL_CALC2 = fourth.appUrl;
  process.env.TEST_SUPER_URL_CALC2 = fourth.superUrl;
  process.env.TEST_DATABASE_URL_DASH = fifth.appUrl;
  process.env.TEST_SUPER_URL_DASH = fifth.superUrl;
  process.env.TEST_DATABASE_URL_DASHPERF = sixth.appUrl;
  process.env.TEST_DATABASE_URL_DASH2 = seventh.appUrl;
  process.env.TEST_SUPER_URL_DASH2 = seventh.superUrl;
  process.env.TEST_SUPER_URL_DASHPERF = sixth.superUrl;

  return async () => {
    if (process.env.TEST_KEEP_DB === '1') return;
    const a = new Client({ connectionString: adminUrl });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await a.query(`DROP DATABASE IF EXISTS ${solo} WITH (FORCE)`);
    await a.query(`DROP DATABASE IF EXISTS ${calc} WITH (FORCE)`);
    await a.query(`DROP DATABASE IF EXISTS ${calc2} WITH (FORCE)`);
    await a.query(`DROP DATABASE IF EXISTS ${dash} WITH (FORCE)`);
    await a.query(`DROP DATABASE IF EXISTS ${dashPerf} WITH (FORCE)`);
    await a.query(`DROP DATABASE IF EXISTS ${dash2} WITH (FORCE)`);
    await a.query(`DROP DATABASE IF EXISTS ${docs} WITH (FORCE)`);
    await a.query(`DROP DATABASE IF EXISTS ${logs} WITH (FORCE)`);
    await a.query(`DROP DATABASE IF EXISTS ${p1} WITH (FORCE)`);
    await a.query(`DROP DATABASE IF EXISTS ${fb} WITH (FORCE)`);
    await a.query(`DROP DATABASE IF EXISTS ${ss} WITH (FORCE)`);
    await a.query(`DROP DATABASE IF EXISTS ${p9} WITH (FORCE)`);
    await a.query(`DROP DATABASE IF EXISTS ${p9m} WITH (FORCE)`);
    await a.query(`DROP DATABASE IF EXISTS ${dashP2} WITH (FORCE)`);
    await a.end();
  };
}
