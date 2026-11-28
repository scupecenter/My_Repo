import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { beginAs, makeAdmin, makeUser, superDb } from './helpers';
import { addAssignment, makeSite, newRole } from './wf-helpers';

/**
 * Migration 0342: the generic if/then alert rules, NOTIFICATIONS ONLY. admin_alert_rule_save manages a rule (admin.settings edit for all regions, a
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

// CI runs every suite against one shared database: never assert on the global return of alert_rules_run (other suites' rows
// match a broad rule too). Scope every run assertion to this rule's fire rows.
const targetFires = async (ruleId: string, period: string, target: string): Promise<number> =>
  Number((await db.query('SELECT count(*)::int AS n FROM alert_rule_fires WHERE rule_id = $1 AND period_key = $2 AND target = $3', [ruleId, period, target])).rows[0].n);

describe('alert rules (0342)', () => {
  it('validates the closed kinds, params, audience and templates with field errors', async () => {
    const fails = async (r: Record<string, unknown>, re: RegExp): Promise<void> => {
      await db.query('BEGIN');
      await beginAs(db, adminId);
      await expect(save(r, 'try an invalid rule')).rejects.toThrow(re);
      await db.query('ROLLBACK');
    };
    await fails(rule(`${PREFIX}-bad-kind`, { kind: 'nope' }), /validation_failed/);
    await fails(rule(`${PREFIX}-bad-aud`, { audience: { type: 'everyone' } }), /audience/);
    await fails(rule(`${PREFIX}-bad-adv`, { kind: 'advance_unsettled', params: { days: 0 } }), /days/);
    await fails(rule(`${PREFIX}-bad-inv`, { kind: 'invoice_due_soon', params: { when: 'soon' } }), /params/);
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
    const weeklyBefore = await fires(code);
    await db.query(`SELECT alert_rules_run('2031-03-07'::date) AS n`);
    expect(await fires(code)).toBe(weeklyBefore);
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
    await db.query(`SELECT alert_rules_run('2031-03-07'::date) AS n`);
    const idleId = idle.rows[0].id as string;
    expect(await targetFires(ruleId, 'day:2031-03-07', idleId)).toBe(1);
    const notes = await db.query(`SELECT user_id, title, body, link FROM notifications WHERE kind = 'alert_rule' AND link = '/registers/issues' AND user_id = $1`, [holder.id]);
    expect(notes.rows.length).toBeGreaterThanOrEqual(1);
    expect(notes.rows[0].body).toContain('entry');
    const wrongNotes = await db.query(`SELECT 1 FROM notifications WHERE kind = 'alert_rule' AND user_id = $1`, [wrongModule.id]);
    expect(wrongNotes.rows.length).toBe(0);
    // the dedupe: a second run of the same day writes nothing, a later day fires again
    await db.query(`SELECT alert_rules_run('2031-03-07'::date) AS n`);
    expect(await targetFires(ruleId, 'day:2031-03-07', idleId)).toBe(1);
    await db.query(`SELECT alert_rules_run('2031-03-08'::date) AS n`);
    expect(await targetFires(ruleId, 'day:2031-03-08', idleId)).toBe(1);
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

  it('advance_unsettled and invoice_due_soon fire once per advance and week and once per invoice and due date', async () => {
    await db.query('BEGIN');
    await beginAs(db, adminId);
    const adv = await save(rule(`${PREFIX}-adv`, { kind: 'advance_unsettled', params: { days: 10 }, title_en: 'Advance {{record}}', body_en: '{{state}} for {{days}} days' }), 'add the advance rule');
    const inv = await save(rule(`${PREFIX}-inv`, { kind: 'invoice_due_soon', params: { days: 5 }, title_en: 'Invoice {{record}}', body_en: 'Due {{due}} in {{days}} days' }), 'add the invoice rule');
    const site = await makeSite(db, REGION, { prefix: PREFIX.toUpperCase() });
    const ins = (key: string, type: string | null, data: Record<string, unknown>) => db.query(
      `INSERT INTO register_records (entity_id, register_key, record_type, site_id, region_id, is_global, is_current, state, current_level, levels_required, level_round, created_by, data)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, false, true, 'approved', 1, 3, 0, $5, $6::jsonb) RETURNING id`,
      [key, type, site.id, REGION, adminId, JSON.stringify(data)]);
    const oldAdv = await ins('financial_advances', 'advance', { advance_state: 'disbursed', disbursed_date: '2031-03-01' });
    await ins('financial_advances', 'advance', { advance_state: 'disbursed', disbursed_date: '2031-03-18' });
    await ins('financial_advances', 'advance', { advance_state: 'settled', disbursed_date: '2031-03-01' });
    const dueInv = await ins('invoices', null, { invoice_no: 'INV-T1', invoice_state: 'Approved', due_date: '2031-03-23' });
    await ins('invoices', null, { invoice_no: 'INV-T2', invoice_state: 'Paid', due_date: '2031-03-23' });
    await ins('invoices', null, { invoice_no: 'INV-T3', invoice_state: 'Approved', due_date: '2031-04-30' });
    await db.query(`SELECT alert_rules_run('2031-03-21'::date) AS n`);
    expect(await targetFires(adv.rows[0].j.id, 'week:2031-03-16', oldAdv.rows[0].id)).toBe(1);
    expect(await targetFires(inv.rows[0].j.id, 'due:2031-03-23', dueInv.rows[0].id)).toBe(1);
    const advFires = await db.query('SELECT count(*)::int AS c FROM alert_rule_fires WHERE rule_id = $1', [adv.rows[0].j.id]);
    const invFires = await db.query('SELECT count(*)::int AS c FROM alert_rule_fires WHERE rule_id = $1', [inv.rows[0].j.id]);
    expect(advFires.rows[0].c).toBeGreaterThanOrEqual(1);
    expect(invFires.rows[0].c).toBeGreaterThanOrEqual(1);
    await db.query(`SELECT alert_rules_run('2031-03-22'::date) AS n`);
    expect((await db.query('SELECT count(*)::int AS c FROM alert_rule_fires WHERE rule_id = $1', [adv.rows[0].j.id])).rows[0].c).toBe(advFires.rows[0].c);
    await db.query('ROLLBACK');
  });

  it('link_orphans (0650) checks its params, fires once per link and week for dangling links and reports example ids', async () => {
    await db.query('BEGIN');
    await beginAs(db, adminId);
    const fails = async (run: () => Promise<unknown>, re: RegExp) => { await db.query('SAVEPOINT s'); await expect(run()).rejects.toThrow(re); await db.query('ROLLBACK TO s'); };
    await db.query(`INSERT INTO register_links (register_key, field_code, target_register, same_site, label_fields, enforce, sort_order)
                    VALUES ('issues', 'orph_test_id', 'risks', false, ARRAY['title'], false, 901)`);
    await fails(() => save(rule(`${PREFIX}-bo1`, { kind: 'link_orphans', params: { register_key: 'nope' } }), 'bad'), /register_key/);
    await fails(() => save(rule(`${PREFIX}-bo2`, { kind: 'link_orphans', params: { field_code: 'orph_test_id' } }), 'bad'), /field_code/);
    await fails(() => save(rule(`${PREFIX}-bo3`, { kind: 'link_orphans', params: { min_rows: 0 } }), 'bad'), /min_rows/);
    await fails(() => save(rule(`${PREFIX}-bo4`, { kind: 'link_orphans', params: { days: 3 } }), 'bad'), /params/);
    const r = await save(rule(`${PREFIX}-orph`, { kind: 'link_orphans', params: { register_key: 'issues', field_code: 'orph_test_id', min_rows: 1 }, title_en: 'Dangling {{register}}.{{field}}', body_en: '{{count}} rows' }), 'add the orphans rule');
    const site = await makeSite(db, REGION, { prefix: PREFIX.toUpperCase() });
    await db.query(
      `INSERT INTO register_records (entity_id, register_key, record_type, site_id, region_id, is_global, is_current, state, current_level, levels_required, level_round, created_by, data)
       VALUES (gen_random_uuid(), 'issues', NULL, $1, $2, false, true, 'entry', 1, 3, 0, $3, $4::jsonb)`,
      [site.id, REGION, adminId, JSON.stringify({ orph_test_id: '11111111-1111-4111-8111-111111111111' })]);
    await db.query(`SELECT alert_rules_run('2031-03-21'::date) AS n`);
    expect(await targetFires(r.rows[0].j.id, 'week:2031-03-16', 'issues.orph_test_id')).toBe(1);
    await db.query(`SELECT alert_rules_run('2031-03-22'::date) AS n`);
    expect(await targetFires(r.rows[0].j.id, 'week:2031-03-16', 'issues.orph_test_id')).toBe(1);
    const rep = await db.query(`SELECT register_link_orphans_json(5) AS j`);
    const row = (rep.rows[0].j as { field_code: string; orphan_rows: number; examples: string[] }[]).find((x) => x.field_code === 'orph_test_id');
    expect(row?.orphan_rows).toBe(1);
    expect(row?.examples).toHaveLength(1);
    await db.query('ROLLBACK');
  });
});

describe('sla_breach alert rules (0672)', () => {
  it('checks its params and fires once per party and week for late snags, with no amount in the text', async () => {
    await db.query('BEGIN');
    await beginAs(db, adminId);
    const fails = async (run: () => Promise<unknown>, re: RegExp) => { await db.query('SAVEPOINT s'); await expect(run()).rejects.toThrow(re); await db.query('ROLLBACK TO s'); };
    await fails(() => save(rule(`${PREFIX}-sb1`, { kind: 'sla_breach', params: { party_type: 'nope_type' } }), 'bad'), /party_type/);
    await fails(() => save(rule(`${PREFIX}-sb2`, { kind: 'sla_breach', params: { min_late_days: 0 } }), 'bad'), /min_late_days/);
    await fails(() => save(rule(`${PREFIX}-sb3`, { kind: 'sla_breach', params: { min_snags: 'x' } }), 'bad'), /min_snags/);
    await fails(() => save(rule(`${PREFIX}-sb4`, { kind: 'sla_breach', params: { days: 3 } }), 'bad'), /params/);
    const party = (await db.query(`INSERT INTO external_parties (name, type, is_active) VALUES ($1, 'cw_contractor', true) RETURNING id`, [`${PREFIX} late party`])).rows[0].id as string;
    const site = await makeSite(db, REGION, { prefix: PREFIX.toUpperCase() });
    const type = (await db.query('SELECT id FROM snag_types WHERE is_active ORDER BY code LIMIT 1')).rows[0].id as string;
    await db.query(
      `INSERT INTO snags (site_id, region_id, snag_type_id, scope, description, raised_by, responsible_party_id, target_date)
       VALUES ($1, $2, $3, 'TE', 'late one', $4, $5, CURRENT_DATE - 5)`, [site.id, REGION, type, adminId, party]);
    const r = await save(rule(`${PREFIX}-sla`, { kind: 'sla_breach', params: { party_type: 'cw_contractor', min_late_days: 3, min_snags: 1 }, title_en: 'Late: {{party}}', body_en: '{{snags}} snags, {{days}} days' }), 'add the rule');
    await db.query(`SELECT alert_rules_run('2031-03-21'::date) AS n`);
    expect(await targetFires(r.rows[0].j.id, 'week:2031-03-16', party)).toBe(1);
    await db.query(`SELECT alert_rules_run('2031-03-22'::date) AS n`);
    expect(await targetFires(r.rows[0].j.id, 'week:2031-03-16', party)).toBe(1);
    await db.query('ROLLBACK');
  });
});

describe('kpi_threshold alert rules (0348)', () => {
  const kpiRule = (code: string, over: Record<string, unknown> = {}): Record<string, unknown> => rule(code, {
    kind: 'kpi_threshold', params: { kpi: 'sla_breach', op: 'above', value: 5 },
    title_en: '{{kpi}} above {{threshold}}', title_ar: '{{kpi}} فوق {{threshold}}',
    body_en: 'The value is {{value}}.', body_ar: 'القيمة {{value}}.', ...over,
  });

  it('validates the kpi_threshold params: a catalogue KPI, above or below, the own threshold a number 0..100000', async () => {
    const fails = async (r: Record<string, unknown>, re: RegExp): Promise<void> => {
      await db.query('BEGIN');
      await beginAs(db, adminId);
      await expect(save(r, 'try an invalid kpi rule')).rejects.toThrow(re);
      await db.query('ROLLBACK');
    };
    await fails(kpiRule(`${PREFIX}-kpi-bad`, { params: { kpi: 'not_a_kpi', op: 'above', value: 5 } }), /\/params\/kpi/);
    await fails(kpiRule(`${PREFIX}-kpi-op`, { params: { kpi: 'sla_breach', op: 'equals', value: 5 } }), /\/params\/op/);
    await fails(kpiRule(`${PREFIX}-kpi-val`, { params: { kpi: 'sla_breach', op: 'above', value: 'high' } }), /\/params\/value/);
    await fails(kpiRule(`${PREFIX}-kpi-neg`, { params: { kpi: 'sla_breach', op: 'above', value: -1 } }), /\/params\/value/);
  });

  it('fires when the live value crosses the own threshold, fills kpi, value and threshold, links the dashboard, and dedupes per day', async () => {
    await db.query('BEGIN');
    await beginAs(db, adminId);
    const code = `${PREFIX}-kpi`;
    const made = await save(kpiRule(code), 'add the kpi rule');
    const ruleId = made.rows[0].j.id as string;
    // below the threshold: no fire; a null (pending) value: no fire
    expect((await db.query(`SELECT alert_rules_kpi_run('{"sla_breach": 3}'::jsonb, '2031-03-07'::date) AS n`)).rows[0].n).toBe(0);
    expect((await db.query(`SELECT alert_rules_kpi_run('{"sla_breach": null}'::jsonb, '2031-03-07'::date) AS n`)).rows[0].n).toBe(0);
    // above the threshold: one fire, the placeholders of the notification are filled
    const n = (await db.query(`SELECT alert_rules_kpi_run('{"sla_breach": 7.5}'::jsonb, '2031-03-07'::date) AS n`)).rows[0].n as number;
    expect(n).toBeGreaterThan(0);
    expect(await targetFires(ruleId, 'day:2031-03-07', 'sla_breach')).toBe(1);
    const note = await db.query(`SELECT title, body, link FROM notifications WHERE kind = 'alert_rule' AND user_id = $1 AND link = '/dashboard' ORDER BY id DESC LIMIT 1`, [adminId]);
    expect(note.rows[0].title).toContain('SLA breaches');
    expect(note.rows[0].title).toContain('5');
    expect(note.rows[0].body).toContain('7.5');
    expect(note.rows[0].title).not.toContain('{{');
    // a second run of the same day adds nothing; the next day fires again
    await db.query(`SELECT alert_rules_kpi_run('{"sla_breach": 9}'::jsonb, '2031-03-07'::date) AS n`);
    expect(await targetFires(ruleId, 'day:2031-03-07', 'sla_breach')).toBe(1);
    await db.query(`SELECT alert_rules_kpi_run('{"sla_breach": 9}'::jsonb, '2031-03-08'::date) AS n`);
    expect(await targetFires(ruleId, 'day:2031-03-08', 'sla_breach')).toBe(1);
    await db.query('ROLLBACK');
  });

  it('a locked rule takes no edit and cannot be disabled until the unlock alone, and a locked rule still fires', async () => {
    await db.query('BEGIN');
    await beginAs(db, adminId);
    const code = `${PREFIX}-lock`;
    const made = await save(kpiRule(code, { locked: true }), 'add the locked rule');
    const ruleId = made.rows[0].j.id as string;
    const row = (await db.query('SELECT locked FROM alert_rules WHERE id = $1', [ruleId])).rows[0];
    expect(row.locked).toBe(true);
    // a locked rule still fires
    await db.query(`SELECT alert_rules_kpi_run('{"sla_breach": 9}'::jsonb, '2031-03-09'::date) AS n`);
    expect(await targetFires(ruleId, 'day:2031-03-09', 'sla_breach')).toBe(1);
    // an edit and a disable are both refused rule_locked (each rejection aborts to the savepoint, the transaction goes on)
    await db.query('SAVEPOINT sp1');
    await expect(save(kpiRule(code, { title_en: 'changed', locked: true }), 'edit a locked rule', ruleId, 1)).rejects.toThrow(/rule_locked/);
    await db.query('ROLLBACK TO SAVEPOINT sp1');
    await expect(save(kpiRule(code, { enabled: false, locked: true }), 'disable a locked rule', ruleId, 1)).rejects.toThrow(/rule_locked/);
    await db.query('ROLLBACK TO SAVEPOINT sp1');
    // the unlock must change nothing else
    await expect(save(kpiRule(code, { title_en: 'changed', locked: false }), 'unlock with an edit', ruleId, 1)).rejects.toThrow(/rule_locked/);
    await db.query('ROLLBACK TO SAVEPOINT sp1');
    // the unlock alone goes through, then edits are free again
    const un = await save(kpiRule(code, { locked: false }), 'unlock the rule', ruleId, 1);
    expect(un.rows[0].j.version).toBe(2);
    const upd = await save(kpiRule(code, { title_en: 'now it changes' }), 'edit after unlock', ruleId, 2);
    expect(upd.rows[0].j.version).toBe(3);
    await db.query('ROLLBACK');
  });
});
