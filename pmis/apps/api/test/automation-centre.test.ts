import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { beginAs, makeAdmin, makeUser, superDb } from './helpers';

/**
 * Migration 0612: the run history of the alert rules (Automation centre). The daily job calls alert_rules_runs_record() right after the rules ran: one run
 * row per enabled rule, and one audit row written by the system (no actor, via job) for a rule that fired. Notifications only; nothing else changes.
 */
const PREFIX = `auc${randomBytes(3).toString('hex')}`;
let db: PgClient;
let adminId: string;

beforeAll(async () => {
  db = await superDb();
  adminId = (await makeAdmin(db)).id;
});
afterAll(async () => {
  await db.end();
});

const save = (rule: unknown, reason: string) => db.query('SELECT admin_alert_rule_save($1::jsonb, $2, NULL::uuid, NULL::int) AS j', [JSON.stringify(rule), reason]);
const rule = (code: string): Record<string, unknown> => ({
  code, kind: 'weekly_status_missing', params: {}, audience: { type: 'system_admin' },
  title_en: 'No weekly status: {{region}}', title_ar: 'لا يوجد تحديث أسبوعي: {{region}}', body_en: 'Week {{week}}', body_ar: 'أسبوع {{week}}',
});

describe('alert rule runs (0612)', () => {
  it('records a run row and one system audit row for a rule that fired, and lists it for the admin', async () => {
    await db.query('BEGIN');
    await beginAs(db, adminId);
    const made = await save(rule(`${PREFIX}-run`), 'add a rule for the run history');
    const ruleId = made.rows[0].j.id as string;
    await makeUser(db, { status: 'active' });
    await db.query(`SELECT alert_rules_run('2031-05-02'::date) AS n`);
    await db.query('SELECT alert_rules_runs_record() AS n');
    const run = await db.query('SELECT fired FROM alert_rule_runs WHERE rule_id = $1', [ruleId]);
    expect(run.rows).toHaveLength(1);
    const targets = Number((await db.query('SELECT count(*)::int AS n FROM alert_rule_fires WHERE rule_id = $1', [ruleId])).rows[0].n);
    expect(run.rows[0].fired).toBe(targets);
    if (targets > 0) {
      const aud = await db.query(`SELECT actor_id, via, job_name, after FROM audit_log WHERE action = 'alert_rule_run' AND entity_id = $1`, [ruleId]);
      expect(aud.rows).toHaveLength(1);
      expect(aud.rows[0].actor_id).toBeNull();
      expect(aud.rows[0].via).toBe('job');
      expect(aud.rows[0].job_name).toBe('alert_rules');
      expect(aud.rows[0].after.targets).toBe(targets);
    }
    const listed = await db.query('SELECT alert_rule_runs_json(200) AS j');
    expect((listed.rows[0].j as { rule_id: string }[]).some((r) => r.rule_id === ruleId)).toBe(true);
    await db.query('ROLLBACK');
  });

  it('records a rule that found nothing at most once per 12 hours', async () => {
    await db.query('BEGIN');
    await beginAs(db, adminId);
    const made = await save({ ...rule(`${PREFIX}-idle`), kind: 'record_idle', params: { register_key: 'issues', state: 'no_such_state', days: 5 } }, 'a rule that finds nothing');
    const ruleId = made.rows[0].j.id as string;
    await db.query('SELECT alert_rules_runs_record() AS n');
    await db.query('SELECT alert_rules_runs_record() AS n');
    const runs = await db.query('SELECT fired FROM alert_rule_runs WHERE rule_id = $1', [ruleId]);
    expect(runs.rows).toEqual([{ fired: 0 }]);
    const aud = await db.query(`SELECT 1 FROM audit_log WHERE action = 'alert_rule_run' AND entity_id = $1`, [ruleId]);
    expect(aud.rows).toHaveLength(0);
    await db.query('ROLLBACK');
  });

  it('keeps the run history out of the app role, readable only through the admin function', async () => {
    await db.query('BEGIN');
    await beginAs(db, adminId);
    await expect(db.query('SELECT alert_rule_runs_json(5) AS j')).resolves.toBeTruthy();
    await db.query('ROLLBACK');
    const plain = await makeUser(db, { status: 'active' });
    await db.query('BEGIN');
    await beginAs(db, plain.id);
    await expect(db.query('SELECT alert_rule_runs_json(5) AS j')).rejects.toThrow();
    await db.query('ROLLBACK');
  });
});
