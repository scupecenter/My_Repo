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

const API_ROOT = resolve(__dirname, '..');
const REPO_PMIS = resolve(API_ROOT, '..', '..');

async function buildDatabase(adminUrl: string, dbName: string, appPassword: string): Promise<{ appUrl: string; superUrl: string }> {
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
  // The 7 regions are seed data (CLAUDE.md), not part of a migration.
  await db.query(`INSERT INTO regions (id, code, name_en) VALUES (1,'TRIPOLI','Tripoli'),(2,'MIDDLE','Middle'),(3,'WM','WM'),(4,'ZAWIA','Zawia'),
    (5,'BENGHAZI','Benghazi'),(6,'GM','GM'),(7,'SEBHA','Sebha')`);

  // Cheap parameters: the test hashes only have to be valid argon2id PHC strings (the API verifies whatever the string says).
  const hash = await argon2.hash(BOOTSTRAP_ADMIN.password, { type: argon2.argon2id, memoryCost: 4096, timeCost: 2, parallelism: 1 });
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
  process.env.TEST_DATABASE_URL = main.appUrl;
  process.env.TEST_SUPER_URL = main.superUrl;
  process.env.TEST_DATABASE_URL_SOLO = one.appUrl;
  process.env.TEST_SUPER_URL_SOLO = one.superUrl;

  return async () => {
    if (process.env.TEST_KEEP_DB === '1') return;
    const a = new Client({ connectionString: adminUrl });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await a.query(`DROP DATABASE IF EXISTS ${solo} WITH (FORCE)`);
    await a.end();
  };
}
