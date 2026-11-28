import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { beginAs, makeAdmin, makeUser, superDb } from './helpers';

/**
 * Migration 0622: assignment rules. Only a System Admin reads or changes them, a rule needs an active person, a change needs the current version, and
 * removing hides the rule (the row stays). Each write leaves an audit row.
 */
let db: PgClient;
let adminId: string;

beforeAll(async () => {
  db = await superDb();
  adminId = (await makeAdmin(db)).id;
});
afterAll(async () => {
  await db.end();
});

const save = (id: string | null, version: number | null, patch: unknown) =>
  db.query('SELECT assignment_rule_save($1::uuid, $2::int, $3::jsonb) AS j', [id, version, JSON.stringify(patch)]);

describe('assignment rules (0622)', () => {
  it('lets a System Admin add, change and remove a rule, with audit rows, and never deletes the row', async () => {
    await db.query('BEGIN');
    await beginAs(db, adminId);
    const person = await makeUser(db, { status: 'active' });
    const made = await save(null, null, { applies_to: 'task', item_key: 'site-visit', user_id: person.id });
    const id = made.rows[0].j.id as string;
    expect(made.rows[0].j.version).toBe(1);
    const listed = await db.query('SELECT assignment_rules_json() AS j');
    expect((listed.rows[0].j.items as { id: string }[]).some((r) => r.id === id)).toBe(true);
    const off = await save(id, 1, { enabled: false });
    expect(off.rows[0].j.version).toBe(2);
    await expect(save(id, 1, { enabled: true })).rejects.toThrow();
    await save(id, 2, { removed: true });
    const after = await db.query('SELECT removed_at FROM assignment_rules WHERE id = $1', [id]);
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0].removed_at).not.toBeNull();
    const aud = await db.query(`SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY created_at`, [id]);
    expect(aud.rows.map((r: { action: string }) => r.action)).toEqual(['assign_rule_create', 'assign_rule_update', 'assign_rule_remove']);
    await db.query('ROLLBACK');
  });

  it('refuses a person who is not an active user and anyone who is not a System Admin', async () => {
    await db.query('BEGIN');
    await beginAs(db, adminId);
    await expect(save(null, null, { applies_to: 'record', user_id: '00000000-0000-4000-8000-000000000001' })).rejects.toThrow();
    await db.query('ROLLBACK');
    await db.query('BEGIN');
    const plain = await makeUser(db, { status: 'active' });
    await beginAs(db, plain.id);
    await expect(db.query('SELECT assignment_rules_json()')).rejects.toThrow();
    await db.query('ROLLBACK');
  });
});
