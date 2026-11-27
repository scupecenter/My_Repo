import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superDb } from './helpers';

/**
 * Migration 0364: mail_policy_check() and its use in mail_enqueue_internal(). The default (setting mail.policy) keeps today's behaviour; the global switch, a kind
 * switch, the internal domains and the security lock decide who is mailed; mandatory mail is never stopped; the catalogue lists the three new kinds.
 */
let db: PgClient;
let saved: unknown;
let lock: unknown;
beforeAll(async () => {
  db = await superDb();
  saved = (await db.query(`SELECT value FROM settings WHERE key = 'mail.policy'`)).rows[0]?.value;
  lock = (await db.query(`SELECT value FROM settings WHERE key = 'security.locks'`)).rows[0]?.value;
});
afterAll(async () => {
  if (saved) await db.query(`UPDATE settings SET value = $1::jsonb WHERE key = 'mail.policy'`, [JSON.stringify(saved)]);
  if (lock) await db.query(`UPDATE settings SET value = $1::jsonb WHERE key = 'security.locks'`, [JSON.stringify(lock)]);
  await db.end();
});
const policy = (v: object) => db.query(`UPDATE settings SET value = $1::jsonb WHERE key = 'mail.policy'`, [JSON.stringify({ version: 1, enabled: true, mode: 'internal_only', internal_domains: [], kinds: {}, ...v })]);
const check = async (kind: string, to: string, mandatory = false) => (await db.query(`SELECT mail_policy_check($1, $2, $3) AS r`, [kind, to, mandatory])).rows[0].r as string | null;

describe('mail policy', () => {
  it('lists the three new kinds in the catalogue', async () => {
    const r = await db.query(`SELECT k ->> 'kind' AS kind FROM jsonb_array_elements(mail_kind_catalogue()) k`);
    const kinds = r.rows.map((x) => x.kind);
    expect(kinds).toEqual(expect.arrayContaining(['expiry_radar', 'approval_digest', 'weekly_digest', 'daily_plan_reminder', 'task_assigned']));
  });
  it('allows everything by default, and with no internal domain every address is internal', async () => {
    await policy({});
    expect(await check('task_assigned', 'a@anywhere.org')).toBeNull();
  });
  it('the global switch and the kind switch stop notification mail, never mandatory mail or security alerts', async () => {
    await policy({ enabled: false });
    expect(await check('task_assigned', 'a@x.com')).toBe('policy_off');
    expect(await check('task_assigned', 'a@x.com', true)).toBeNull();
    expect(await check('security_alert', 'a@x.com')).toBeNull();
    await policy({ kinds: { expiry_radar: { enabled: false, mode: 'inherit' } } });
    expect(await check('expiry_radar', 'a@x.com')).toBe('kind_off');
    expect(await check('task_assigned', 'a@x.com')).toBeNull();
  });
  it('an external address needs the external mode, a kind may override, and the security lock blocks it', async () => {
    await policy({ internal_domains: ['corp.example'] });
    expect(await check('task_assigned', 'a@corp.example')).toBeNull();
    expect(await check('task_assigned', 'a@outside.org')).toBe('external_not_allowed');
    await policy({ internal_domains: ['corp.example'], mode: 'internal_external', kinds: { mention: { enabled: true, mode: 'internal_only' } } });
    expect(await check('task_assigned', 'a@outside.org')).toBeNull();
    expect(await check('mention', 'a@outside.org')).toBe('external_not_allowed');
    await db.query(`UPDATE settings SET value = jsonb_set(value, '{block_public_sharing}', 'true') WHERE key = 'security.locks'`);
    expect(await check('task_assigned', 'a@outside.org')).toBe('security_lock');
    expect(await check('task_assigned', 'a@corp.example')).toBeNull();
  });
  it('a refused mail is stored as suppressed with the reason', async () => {
    await policy({ enabled: false });
    const id = (await db.query(`SELECT mail_enqueue_internal('task_assigned', 'p1@corp.example', NULL, 'Subject', 'Body', $1, false, NULL) AS id`, [`mp-${Date.now()}`])).rows[0].id as string;
    expect((await db.query(`SELECT status::text AS s FROM mail_outbox WHERE id = $1`, [id])).rows[0].s).toBe('suppressed');
  });
});
