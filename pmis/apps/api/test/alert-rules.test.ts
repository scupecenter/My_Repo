import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { beginAs, makeAdmin, makeUser, superDb } from './helpers';
import { addAssignment, makeSite, newRole } from './wf-helpers';

/**
 * Migration 0202: the generic if/then alert rules, NOTIFICATIONS ONLY. admin_alert_rule_save manages a rule (admin.settings edit for all regions, a
 * reason, one audit row); alert_rules_run / alert_rule_notify write one in-app notification per recipient per rule per period and target, in the
 * recipient's language, deduped by alert_rule_fires. They change no record, state, owner or permission.
 */
const REGION = 7;
const PREFIX = `alr${randomBytes(3).toString('hex')}`;   // rule codes are lowercase
let db: PgClient;
let adminId: string;

beforeAll(async () => {
  db = await superDb();
  adminId = (await makeAdmin(db)).id;
});
afterAll(async () => {
  await db.end();
});

const save = (rule: unknown, reason: string, id: string | null = null, version: number | null = null) =>
  db.query('SELECT admin_alert_rule_save($1::jsonb, $2, $3::uuid, $4::int) AS j', [JSON.stringify(rule), reason, id, version]);

const rule = (code: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  code, kind: 'weekly_status_missing', params: {}, audience: { type: 'system_admin' },
  title_en: 'No weekly status: {{region}}', title_ar: 'لا يوجد تحديث أسبوعي: {{region}}',
  body_en: 'Week {{week}}', body_ar: 'أسبوع {{week}}', ...over,
});

const fires = async (code: string): Promise<number> =>
  Number((await db.query('SELECT count(*)::int AS n FROM alert_rule_fires f JOIN alert_rules r ON r.id = f.rule_id WHERE r.code = $1', [code])).rows[0].n);

describe('alert rules (0202)', () => {
  it('validates the closed kinds, params, audience and templates with field errors', async () => {
    const fails = async (r: Record<string, unknown>, re: RegExp): Promise<void> => {
      await db.query('BEGIN');
      await beginAs(db, adminId);
      await expect(save(r, 'try an invalid rule')).rejects.toThrow(re);
      await db.query('ROLLBACK');
    };
    await fails(rule(`${PREFIX}-bad-kind`, { kind: 'nope' }), /validation_failed/);
    await fails(rule(`${PREFIX}-bad-aud`, { audience: { type: 'everyone' } }), /audience/);
    await fails(rule(`${PREFIX}-bad-idle`, { kind: 'record_idle', params: { register_key: 'issues', state: 'entry', days: 'soon' } }), /days/);
    await fails(rule(`${PREFIX}-short`, { title_en: '  ' }), /title_en/);
  });

  it('creates and updates a rule with a reason and an audit row; the update needs the version', async () => {
    await db.query('BEGIN');
    await beginAs(db, adminId);
    const code = `${PREFIX}-crud`;
    const made = await save(rule(code), 'add the rule');
    const id = made.rows[0].j.id as string;
    expect(made.rows[0].j.version).toBe(1);
    const upd = await save(rule(code, { title_en: 'changed', enabled: false }), 'rename it', id, 1);
    expect(upd.rows[0].j.version).toBe(2);
    const list = (await db.query('SELECT alert_rules_json() AS j')).rows[0].j as { code: string; enabled: boolean; version: number }[];
    const row = list.find((x) => x.code === code);
    expect(row).toMatchObject({ enabled: false, version: 2 });
    const audit = await db.query(`SELECT action, entity_type, entity_id FROM audit_log WHERE entity_id = $1 AND action LIKE 'alert_rule%' ORDER BY id`, [id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['alert_rule_create', 'alert_rule_update']);
    // the rejecting call comes last: the error aborts the transaction, which the ROLLBACK then ends
    await expect(save(rule(code, { title_en: 'changed again' }), 'update without the version', id, null)).rejects.toThrow(/precondition_failed/);
    await db.query('ROLLBACK');
  });

  it('weekly_status_missing notifies the System Admins once per region and week, in the recipient language, and a second run adds nothing', async () => {
    await db.query('BEGIN');
    await beginAs(db, adminId);
    const code = `${PREFIX}-weekly`;
    const made = await save(rule(code), 'add the weekly rule');
    const ruleId = made.rows[0].j.id as string;
    // a Sunday week in the far past: no region has an update of that week
    const n1 = (await db.query(`SELECT alert_rules_run('2031-03-07'::date) AS n`)).rows[0].n as number;
    expect(n1).toBeGreaterThan(0);
    const adminNote = await db.query(`SELECT title, body, link, channel::text AS channel FROM notifications WHERE kind = 'alert_rule' AND user_id = $1 ORDER BY title`, [adminId]);
    expect(adminNote.rows.length).toBeGreaterThan(0);
    expect(adminNote.rows[0]).toMatchObject({ channel: 'in_app', link: '/status-updates' });
    expect(adminNote.rows[0].title).not.toContain('{{');
    const arab = await makeUser(db, { status: 'active' });
    await db.query(`UPDATE users SET locale = 'ar' WHERE id = $1`, [arab.id]);
    await db.query(`INSERT INTO group_members (group_id, user_id) SELECT g.id, $1 FROM groups g WHERE g.is_system_admins AND g.is_active LIMIT 1`, [arab.id]);
    expect((await db.query(`SELECT alert_rules_run('2031-03-07'::date) AS n`)).rows[0].n).toBe(0);
    // a later week fires again and the Arabic recipient gets the Arabic template
    const n2 = (await db.query(`SELECT alert_rules_run('2031-03-14'::date) AS n`)).rows[0].n as number;
    expect(n2).toBeGreaterThan(0);
    const arabNote = await db.query(`SELECT title FROM notifications WHERE kind = 'alert_rule' AND user_id = $1`, [arab.id]);
    expect(arabNote.rows[0].title).toContain('لا يوجد تحديث أسبوعي');
    expect(await fires(code)).toBeGreaterThan(0);
    // disabled rule stops firing
    await db.query('UPDATE alert_rules SET enabled = false WHERE id = $1', [ruleId]);
    const before = await fires(code);
    await db.query(`SELECT alert_rules_run('2031-03-21'::date) AS n`);
    expect(await fires(code)).toBe(before);
    await db.query('ROLLBACK');
  });

  it('record_idle fires for a record in the state at least `days` days, and the module audience reaches the module holders of the record region', async () => {
    await db.query('BEGIN');
    await beginAs(db, adminId);
    const code = `${PREFIX}-idle`;
    const made = await save(rule(code, {
      kind: 'record_idle', params: { register_key: 'issues', state: 'entry', days: 10 },
      audience: { type: 'module', module: 'issues' },
      title_en: 'Idle record {{record}}', body_en: 'In state {{state}} for {{days}} days',
    }), 'add the idle rule');
    const ruleId = made.rows[0].j.id as string;
    const roleId = await newRole(db);
    const holder = await makeUser(db, { status: 'active' });
    const wrongModule = await makeUser(db, { status: 'active' });
    await addAssignment(db, holder.id, { roleId, regions: [REGION], modules: ['issues'] });
    await addAssignment(db, wrongModule.id, { roleId, regions: [REGION], modules: ['sites'] });
    // an idle current record (in the state for 20 days) and a fresh one
    const site = await makeSite(db, REGION, { prefix: PREFIX.toUpperCase() });
    const idle = await db.query(
      `INSERT INTO register_records (entity_id, register_key, site_id, region_id, is_global, is_current, state, current_level, levels_required, level_round, created_by, updated_at)
       VALUES (gen_random_uuid(), 'issues', $3, $1, false, true, 'entry', 1, 3, 0, $2, now() - interval '20 days') RETURNING id`,
      [REGION, adminId, site.id],
    );
    await db.query(
      `INSERT INTO register_records (entity_id, register_key, site_id, region_id, is_global, is_current, state, current_level, levels_required, level_round, created_by, updated_at)
       VALUES (gen_random_uuid(), 'issues', $3, $1, false, true, 'entry', 1, 3, 0, $2, now())`,
      [REGION, adminId, site.id],
    );
    const n = (await db.query(`SELECT alert_rules_run('2031-03-07'::date) AS n`)).rows[0].n as number;
    expect(n).toBe(1);
    const notes = await db.query(`SELECT user_id, title, body, link FROM notifications WHERE kind = 'alert_rule' AND link = '/registers/issues'`, []);
    expect(notes.rows.map((r) => r.user_id)).toEqual([holder.id]);
    expect(notes.rows[0].body).toContain('entry');
    // the dedupe: a second run of the same day writes nothing, a later day fires again
    expect((await db.query(`SELECT alert_rules_run('2031-03-07'::date) AS n`)).rows[0].n).toBe(0);
    expect((await db.query(`SELECT alert_rules_run('2031-03-08'::date) AS n`)).rows[0].n).toBe(1);
    await db.query('DELETE FROM register_records WHERE id = $1', [idle.rows[0].id]);
    await db.query('UPDATE alert_rules SET enabled = false WHERE id = $1', [ruleId]);
    await db.query('ROLLBACK');
  });

  it('a non-admin cannot read or save the rules (403-style privilege error)', async () => {
    const plain = await makeUser(db, { status: 'active' });
    await db.query('BEGIN');
    await beginAs(db, plain.id);
    await expect(db.query('SELECT alert_rules_json()')).rejects.toThrow(/insufficient_privilege|admin path/);
    await db.query('ROLLBACK');
    await db.query('BEGIN');
    await beginAs(db, plain.id);
    await expect(save(rule(`${PREFIX}-noauth`), 'try without rights')).rejects.toThrow(/insufficient_privilege|admin path/);
    await db.query('ROLLBACK');
  });
});
