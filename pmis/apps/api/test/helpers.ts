import type { NestExpressApplication } from '@nestjs/platform-express';
import * as argon2 from 'argon2';
import { randomBytes, randomInt } from 'node:crypto';
import { Client as PgClient } from 'pg';
import request from 'supertest';
import { createApp } from '../src/app.factory';
import type { AppConfig } from '../src/config/config';
import { BOOTSTRAP_ADMIN } from './global-setup';

export const API = '/api/v1';
export const PASSWORD = 'Correct-Horse-Battery-9';
export const NEW_PASSWORD = 'Another-Strong-Phrase-42';

export function testConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: 'test',
    databaseUrl: process.env.TEST_DATABASE_URL as string, // connects as pmis_app
    port: 0,
    host: '127.0.0.1',
    cookieSecure: false,
    logHmacKey: 'test-only-hmac-key-0123456789abcdef',
    ...over,
  };
}

export async function startApp(over: Partial<AppConfig> = {}): Promise<NestExpressApplication> {
  const app = await createApp(testConfig(over), { logger: false });
  await app.init();
  return app;
}

/** Superuser connection to the test database, for fixtures and for reading what pmis_app cannot read. */
export async function superDb(solo = false): Promise<PgClient> {
  const c = new PgClient({ connectionString: solo ? process.env.TEST_SUPER_URL_SOLO : process.env.TEST_SUPER_URL });
  await c.connect();
  return c;
}

let seq = 0;
const uniq = (): string => `${process.pid}${Date.now().toString(36)}${(seq++).toString(36)}${randomBytes(2).toString('hex')}`;

export interface TestUser {
  id: string;
  email: string;
  employeeId: string;
  phone: string;
  password: string;
  name: string;
}

export interface MakeUserOptions {
  status?: 'pending_assignment' | 'active' | 'suspended' | 'disabled';
  mustChange?: boolean;
  /** an active assignment (all regions, all modules) so the user is not pending */
  assigned?: boolean;
  password?: string;
  name?: string;
}

export async function hashFast(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 4096, timeCost: 2, parallelism: 1 });
}

async function freeEmployeeId(db: PgClient): Promise<string> {
  for (;;) {
    const id = String(randomInt(1000, 9000));
    const r = await db.query('SELECT 1 FROM users WHERE employee_id = $1', [id]);
    if (r.rowCount === 0) return id;
  }
}

async function freePhone(db: PgClient): Promise<string> {
  for (;;) {
    const p = `+21892${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;
    const r = await db.query('SELECT 1 FROM users WHERE phone = $1', [p]);
    if (r.rowCount === 0) return p;
  }
}

export async function ensureRole(db: PgClient, code = 'TEST_ROLE'): Promise<string> {
  const r = await db.query(
    `INSERT INTO roles (code, name_en) VALUES ($1, $1) ON CONFLICT (code) DO UPDATE SET name_en = EXCLUDED.name_en RETURNING id`,
    [code],
  );
  return r.rows[0].id as string;
}

/** A permission profile with the given (module, action) grants, created straight in the database. Returns its id. */
export async function makeProfile(db: PgClient, grants: [string, string][], code = `PROF_${uniq()}`): Promise<string> {
  const p = await db.query('INSERT INTO permission_profiles (code, name_en) VALUES ($1, $1) RETURNING id', [code]);
  for (const [m, a] of grants) await db.query('INSERT INTO permission_grants (profile_id, module_key, action) VALUES ($1, $2, $3::"PermissionAction")', [p.rows[0].id, m, a]);
  return p.rows[0].id as string;
}

/** A role with a unique code, created straight in the database. Returns its id. */
export async function makeRole(db: PgClient, over: { code?: string; parent?: string; profile?: string; regions?: number[]; allRegions?: boolean; modules?: string[]; allModules?: boolean; canHold?: boolean } = {}): Promise<string> {
  const code = over.code ?? `ROLE_${uniq().toUpperCase()}`;
  const r = await db.query(
    `INSERT INTO roles (code, name_en, parent_role_id, default_profile_id, default_all_regions, default_all_modules, can_hold_matrix_levels) VALUES ($1, $1, $2, $3, $4, $5, $6) RETURNING id`,
    [code, over.parent ?? null, over.profile ?? null, over.allRegions ?? false, over.allModules ?? false, over.canHold ?? true],
  );
  for (const region of over.regions ?? []) await db.query('INSERT INTO role_default_regions (role_id, region_id) VALUES ($1, $2)', [r.rows[0].id, region]);
  for (const m of over.modules ?? []) await db.query('INSERT INTO role_default_modules (role_id, module_key) VALUES ($1, $2)', [r.rows[0].id, m]);
  return r.rows[0].id as string;
}

/** A System Admin who is signed in and has passed step-up. */
export async function adminApi(app: NestExpressApplication, db: PgClient): Promise<{ admin: TestUser; api: Api }> {
  const admin = await makeAdmin(db);
  const api = await loggedIn(app, admin);
  const res = await api.stepUp(admin.password);
  if (res.status !== 200) throw new Error(`step-up failed in test setup: ${res.status} ${JSON.stringify(res.body)}`);
  return { admin, api };
}

/** A local account created straight in the database (as the superuser), the way idm_create_local_user would leave it. */
export async function makeUser(db: PgClient, o: MakeUserOptions = {}): Promise<TestUser> {
  const tag = uniq();
  const email = `user.${tag}@example.test`;
  const password = o.password ?? PASSWORD;
  const name = o.name ?? `Test User ${tag}`;
  const status = o.status ?? (o.assigned === false ? 'pending_assignment' : 'active');
  // Suites run in parallel on one database: another suite may take the same random employee id or phone between the check and the insert.
  let employeeId = '';
  let phone = '';
  let id = '';
  for (let attempt = 0; ; attempt++) {
    employeeId = await freeEmployeeId(db);
    phone = await freePhone(db);
    try {
      const u = await db.query(
        `INSERT INTO users (email, display_name, employee_id, phone, status, updated_at) VALUES ($1, $2, $3, $4, $5::"UserStatus", now()) RETURNING id`,
        [email, name, employeeId, phone, status],
      );
      id = u.rows[0].id as string;
      break;
    } catch (e) {
      if ((e as { code?: string }).code !== '23505' || attempt >= 8) throw e;
    }
  }
  await db.query('INSERT INTO local_credentials (user_id, password_hash, must_change) VALUES ($1, $2, $3)', [id, await hashFast(password), o.mustChange ?? false]);
  if (o.assigned) await assign(db, id);
  return { id, email, employeeId, phone, password, name };
}

export async function assign(db: PgClient, userId: string, roleCode = 'TEST_ROLE'): Promise<string> {
  const role = await ensureRole(db, roleCode);
  const a = await db.query(
    `INSERT INTO user_role_assignments (user_id, role_id, permission_level, all_regions, all_modules) VALUES ($1, $2, 'view', true, true) RETURNING id`,
    [userId, role],
  );
  return a.rows[0].id as string;
}

/** A profile with the given (module, action) grants, applied to a new assignment of the user. */
export async function grantProfile(db: PgClient, userId: string, grants: [string, string][]): Promise<void> {
  const code = `PROF_${uniq()}`;
  const p = await db.query('INSERT INTO permission_profiles (code, name_en) VALUES ($1, $1) RETURNING id', [code]);
  for (const [m, a] of grants) await db.query('INSERT INTO permission_grants (profile_id, module_key, action) VALUES ($1, $2, $3::"PermissionAction")', [p.rows[0].id, m, a]);
  const aid = await assign(db, userId, `ROLE_${code}`);
  await db.query('INSERT INTO user_role_assignment_profiles (assignment_id, profile_id) VALUES ($1, $2)', [aid, p.rows[0].id]);
}

/** A partial delegation to a user, made by the bootstrap admin, covering (module, action) in all regions (or only the given ones). */
export async function delegate(db: PgClient, toUserId: string, grants: [string, string][], regions?: number[]): Promise<void> {
  const from = await db.query('SELECT id FROM users WHERE email = $1', [BOOTSTRAP_ADMIN.email]);
  const d = await db.query(
    `INSERT INTO delegations (from_user_id, target_kind, target_user_id, is_full, all_regions, valid_from, reason)
     VALUES ($1, 'user', $2, false, $3, now() - interval '1 minute', 'test') RETURNING id`,
    [from.rows[0].id, toUserId, regions === undefined],
  );
  for (const r of regions ?? []) await db.query('INSERT INTO delegation_regions (delegation_id, region_id) VALUES ($1, $2)', [d.rows[0].id, r]);
  for (const [m, a] of grants) await db.query('INSERT INTO delegation_grants (delegation_id, module_key, action) VALUES ($1, $2, $3::"PermissionAction")', [d.rows[0].id, m, a]);
}

/** A System Admin through idm_bootstrap_admin (same path as the installer). */
export async function makeAdmin(db: PgClient, password = PASSWORD): Promise<TestUser> {
  const tag = uniq();
  const email = `admin.${tag}@example.test`;
  let employeeId = await freeEmployeeId(db);
  let phone = await freePhone(db);
  const name = `Test Admin ${tag}`;
  const hash = await hashFast(password);
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await db.query('SELECT idm_bootstrap_admin($1, $2, $3, $4, $5) AS id', [email, name, employeeId, phone, hash]);
      return { id: r.rows[0].id as string, email, employeeId, phone, password, name };
    } catch (e) {
      if ((e as { code?: string }).code !== '23505' || attempt >= 8) throw e;
      employeeId = await freeEmployeeId(db);
      phone = await freePhone(db);
    }
  }
}

let ipSeq = randomInt(1, 200);

/** A cookie-aware HTTP client for one app. Each client has its own client address (X-Forwarded-For, trusted from loopback only). */
export class Api {
  token: string | undefined;
  csrf: string | undefined;
  readonly ip: string;

  constructor(readonly app: NestExpressApplication, ip?: string) {
    this.ip = ip ?? `10.${ipSeq++ % 250}.${randomInt(0, 250)}.${randomInt(1, 250)}`;
  }

  raw(method: 'get' | 'post' | 'patch' | 'delete' | 'put', path: string): request.Test {
    const t = request(this.app.getHttpServer())[method](`${API}${path}`).set('X-Forwarded-For', this.ip);
    if (this.token) t.set('Cookie', `pmis_session=${this.token}`);
    return t;
  }

  /** Same as raw but with the CSRF header of this session. */
  call(method: 'get' | 'post' | 'patch' | 'delete' | 'put', path: string, body?: unknown, headers: Record<string, string> = {}): request.Test {
    const t = this.raw(method, path);
    if (this.csrf) t.set('X-CSRF-Token', this.csrf);
    for (const [k, v] of Object.entries(headers)) t.set(k, v);
    if (body !== undefined) t.send(body as object);
    return t;
  }

  async login(identifier: string, password: string): Promise<request.Response> {
    const res = await request(this.app.getHttpServer())
      .post(`${API}/auth/local/login`)
      .set('X-Forwarded-For', this.ip)
      .send({ identifier, password });
    if (res.status === 200) {
      this.token = tokenFromSetCookie(res);
      this.csrf = res.body.csrf_token;
    }
    return res;
  }

  async stepUp(password: string): Promise<request.Response> {
    return this.call('post', '/auth/local/step-up', { password });
  }
}

export function setCookies(res: request.Response): string[] {
  const h = res.headers['set-cookie'] as unknown;
  return Array.isArray(h) ? (h as string[]) : h ? [String(h)] : [];
}

export function tokenFromSetCookie(res: request.Response): string | undefined {
  const c = setCookies(res).find((x) => x.startsWith('pmis_session='));
  return c ? c.split(';')[0]!.slice('pmis_session='.length) : undefined;
}

export async function loggedIn(app: NestExpressApplication, u: TestUser, by: 'email' | 'employeeId' | 'phone' = 'email'): Promise<Api> {
  const api = new Api(app);
  const res = await api.login(u[by], u.password);
  if (res.status !== 200) throw new Error(`login failed in test setup: ${res.status} ${JSON.stringify(res.body)}`);
  return api;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
