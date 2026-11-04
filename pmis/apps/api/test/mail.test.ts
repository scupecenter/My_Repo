import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client as PgClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type MailConfig } from '../src/config/config';
import { MailService } from '../src/mail/mail.service';
import { SmtpError, buildMessage, encodeHeader, smtpSend } from '../src/mail/smtp';
import { FakeSmtp } from './fake-smtp';
import { TEST_CONTEXT_KEY } from './global-setup';
import { API, TEST_FILE_ENC_KEY, TEST_TOTP_ENC_KEY, adminApi, loggedIn, makeUser, startApp } from './helpers';

/**
 * The outbound mail service (owner answer Q167, migration 0055, contract 0.12.3) against a fake SMTP server on the loopback interface. Runs on its own
 * database (TEST_DATABASE_URL_P9M). Nothing here depends on the weekday, the time zone or the collation.
 */
const fake = new FakeSmtp({ user: 'pmis-relay', pass: 'relay-secret-Pass-1' });
let app: NestExpressApplication;
let db: PgClient;
let mailCfg: MailConfig;

beforeAll(async () => {
  await fake.listen();
  mailCfg = {
    enabled: true, host: '127.0.0.1', port: fake.port, tls: 'none', user: 'pmis-relay', pass: 'relay-secret-Pass-1', fromAddress: 'pmis@aljeel.test',
    fromHeader: 'GSDN PMIS <pmis@aljeel.test>', rejectUnauthorized: true, timeoutMs: 5000, heloName: 'pmis.test',
  };
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_P9M as string, mail: mailCfg, appBaseUrl: 'https://pmis.aljeel.test' });
  db = new PgClient({ connectionString: process.env.TEST_SUPER_URL_P9M });
  await db.connect();
});
afterAll(async () => {
  await db.end();
  await app.close();
  await fake.close();
});

const mail = (): MailService => app.get(MailService);
const outbox = async (id: string): Promise<Record<string, any>> => (await db.query('SELECT * FROM mail_outbox WHERE id = $1', [id])).rows[0];
/** Makes a waiting mail due now (the outbox guard lets only pmis_definer change a row). */
async function makeDue(id: string): Promise<void> {
  await db.query('BEGIN');
  await db.query('SET LOCAL ROLE pmis_definer');
  await db.query('UPDATE mail_outbox SET next_attempt_at = now() WHERE id = $1', [id]);
  await db.query('COMMIT');
}
async function setSetting(key: string, value: unknown): Promise<void> {
  await db.query(`INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, JSON.stringify(value)]);
}
/** Drains the queue, then answers what the fake received for this address. */
async function deliveredTo(address: string) {
  await mail().processQueue(200);
  return fake.received.filter((r) => r.to.includes(address));
}

const BASE_ENV = {
  NODE_ENV: 'test', DATABASE_URL: 'postgresql://x@127.0.0.1/x', LOG_HMAC_KEY: 'test-only-hmac-key-0123456789abcdef', TOTP_ENC_KEY: TEST_TOTP_ENC_KEY, FILE_ENC_KEY: TEST_FILE_ENC_KEY, PMIS_CONTEXT_KEY: TEST_CONTEXT_KEY,
};

describe('SMTP settings from the environment', () => {
  it('is off when SMTP_HOST is empty', () => {
    const c = loadConfig({ ...BASE_ENV });
    expect(c.mail?.enabled).toBe(false);
    expect(loadConfig({ ...BASE_ENV, SMTP_HOST: '  ' }).mail?.enabled).toBe(false);
  });

  it('reads host, port, TLS mode, credentials and the sender with its display name', () => {
    const c = loadConfig({ ...BASE_ENV, SMTP_HOST: 'relay.aljeel.local', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'GSDN PMIS <pmis@aljeel.ly>', APP_BASE_URL: 'https://pmis.aljeel.local/' });
    expect(c.mail).toMatchObject({ enabled: true, host: 'relay.aljeel.local', port: 587, tls: 'starttls', user: 'u', pass: 'p', fromAddress: 'pmis@aljeel.ly',
      fromHeader: 'GSDN PMIS <pmis@aljeel.ly>', rejectUnauthorized: true });
    expect(c.appBaseUrl).toBe('https://pmis.aljeel.local');
    expect(loadConfig({ ...BASE_ENV, SMTP_HOST: 'r', SMTP_PORT: '465', SMTP_FROM: 'pmis@aljeel.ly' }).mail).toMatchObject({ tls: 'tls', port: 465 });
  });

  it('refuses a half or unsafe configuration with one readable error', () => {
    expect(() => loadConfig({ ...BASE_ENV, SMTP_HOST: 'r' })).toThrow(/SMTP_FROM/);
    expect(() => loadConfig({ ...BASE_ENV, SMTP_HOST: 'r', SMTP_FROM: 'pmis@aljeel.ly', SMTP_USER: 'u' })).toThrow(/SMTP_USER and SMTP_PASS/);
    expect(() => loadConfig({ ...BASE_ENV, SMTP_HOST: 'r', SMTP_FROM: 'pmis@aljeel.ly', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_TLS: 'none' })).toThrow(/in clear/);
    expect(loadConfig({ ...BASE_ENV, SMTP_HOST: 'r', SMTP_FROM: 'pmis@aljeel.ly', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_TLS: 'none', SMTP_ALLOW_PLAIN_AUTH: 'true' }).mail?.enabled).toBe(true);
    expect(() => loadConfig({ ...BASE_ENV, SMTP_HOST: 'r', SMTP_FROM: 'Bad\r\nBcc: x@y.z <pmis@aljeel.ly>' })).toThrow(/SMTP_FROM/);
  });
});

describe('the SMTP client', () => {
  it('encodes an Arabic subject and refuses a header with a line break', () => {
    const enc = encodeHeader('تنبيه أمني من نظام إدارة المشاريع GSDN PMIS');
    expect(enc).toMatch(/^=\?UTF-8\?B\?/);
    expect(() => encodeHeader('a\r\nBcc: someone@example.test')).toThrow(SmtpError);
    const { data } = buildMessage(mailCfg, { to: 'a@example.test', subject: 'Hello', text: 'line 1\n.line 2' });
    expect(data).toMatch(/^From: "GSDN PMIS" <pmis@aljeel\.test>\r\nTo: <a@example\.test>\r\nSubject: Hello\r\n/);
    expect(data).toContain('Content-Transfer-Encoding: base64');
    expect(() => buildMessage(mailCfg, { to: 'a@example.test\r\nBcc: b@example.test', subject: 'x', text: 'y' })).toThrow(SmtpError);
  });

  it('sends one mail with AUTH PLAIN; the fake reads the body back', async () => {
    const r = await smtpSend(mailCfg, { to: 'reader@example.test', subject: 'رسالة اختبار', text: 'سطر أول\n.dot line', kind: 'mail.test' });
    expect(r.messageId).toMatch(/@aljeel\.test$/);
    const got = fake.received.find((x) => x.to.includes('reader@example.test'))!;
    expect(got.auth).toBe('PLAIN pmis-relay');
    expect(got.from).toBe('pmis@aljeel.test');
    expect(got.subject).toBe('رسالة اختبار');
    expect(got.text).toBe('سطر أول\r\n.dot line');
    expect(got.headers['x-pmis-kind']).toBe('mail.test');
    expect(got.headers['auto-submitted']).toBe('auto-generated');
  });

  it('never goes on without TLS when STARTTLS is required: no AUTH and no MAIL FROM are sent', async () => {
    const plain = new FakeSmtp({ starttls: false });
    await plain.listen();
    try {
      const err = await smtpSend({ ...mailCfg, port: plain.port, tls: 'starttls' }, { to: 'x@example.test', subject: 's', text: 't' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SmtpError);
      expect((err as SmtpError).permanent).toBe(true);
      expect((err as Error).message).toMatch(/does not offer STARTTLS/);
      expect(plain.commands.some((c) => c === 'AUTH' || c.startsWith('MAIL'))).toBe(false);
    } finally {
      await plain.close();
    }
  });

  it('refuses a server that sends plain-text data after its STARTTLS reply (response injection): no upgrade, no AUTH, no MAIL FROM', async () => {
    const evil = new FakeSmtp({ starttls: true, starttlsInject: true });
    await evil.listen();
    try {
      const err = await smtpSend({ ...mailCfg, port: evil.port, tls: 'starttls' }, { to: 'x@example.test', subject: 's', text: 't' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SmtpError);
      expect((err as Error).message).toMatch(/after its STARTTLS reply/);
      expect(evil.commands.some((c) => c === 'AUTH' || c.startsWith('MAIL'))).toBe(false);
    } finally {
      await evil.close();
    }
  });

  it('a wrong password is a permanent refusal that never quotes the AUTH line', async () => {
    const err = await smtpSend({ ...mailCfg, pass: 'wrong-Secret-9' }, { to: 'x@example.test', subject: 's', text: 't' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmtpError);
    expect((err as SmtpError).code).toBe(535);
    expect((err as Error).message).toMatch(/^AUTH refused: 535/);
    expect((err as Error).message).not.toContain('wrong-Secret-9');
    expect((err as Error).message).not.toContain(Buffer.from('\0pmis-relay\0wrong-Secret-9').toString('base64'));
  });
});

describe('the queue: sendToUser, the worker, retry and the dead letter', () => {
  it('queues inside the caller, sends from the worker, writes a job run and a System Log row without the body', async () => {
    const u = await makeUser(db, { assigned: true });
    const id = await mail().sendToUser(u.id, { kind: 'identity.notice', subject: 'Your profile changed', text: 'Hello. Open {{app_url}}/me/profile to see it.' });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await outbox(id!)).status).toBe('queued');
    const runsBefore = Number((await db.query(`SELECT count(*) FROM job_runs WHERE name = 'mail_send'`)).rows[0].count);
    const got = await deliveredTo(u.email);
    expect(got).toHaveLength(1);
    expect(got[0]!.text).toBe('Hello. Open https://pmis.aljeel.test/me/profile to see it.');
    expect(got[0]!.headers['message-id']).toBe(`<${id}@aljeel.test>`);
    const row = await outbox(id!);
    expect(row.status).toBe('sent');
    expect(row.attempts).toBe(1);
    expect(row.sent_at).not.toBeNull();
    expect(Number((await db.query(`SELECT count(*) FROM job_runs WHERE name = 'mail_send'`)).rows[0].count)).toBeGreaterThan(runsBefore);
    const logs = await db.query(`SELECT message, context::text AS c FROM system_log WHERE source = 'mail' AND context ->> 'mail_id' = $1 ORDER BY id`, [id]);
    expect(logs.rows.map((r) => r.message)).toEqual(['mail queued', 'mail sent']);
    for (const r of logs.rows) {
      expect(r.c).not.toContain(u.email);
      expect(r.c).toContain(`${u.email[0]}***@example.test`);
      expect(r.c).not.toContain('to see it');
      expect(r.c).not.toContain('relay-secret');
    }
    // a dedup key is queued once
    const k = `once-${id}`;
    expect(await mail().sendToUser(u.id, { kind: 'identity.notice', subject: 's', text: 't', dedupKey: k })).not.toBeNull();
    expect(await mail().sendToUser(u.id, { kind: 'identity.notice', subject: 's', text: 't', dedupKey: k })).toBeNull();
    await mail().processQueue(200);
  });

  it('a temporary refusal is retried with back-off; a permanent one is given up at once and the System Admins are told in-app', async () => {
    const u = await makeUser(db, { assigned: true });
    let code = 451;
    const flaky = new FakeSmtp({ rcptCode: () => code });
    await flaky.listen();
    const saved = { ...mailCfg };
    Object.assign((mail() as unknown as { cfg: MailConfig }).cfg, { port: flaky.port, user: undefined, pass: undefined });
    try {
      const id = (await mail().sendToUser(u.id, { kind: 'identity.notice', subject: 'Retry me', text: 'x' }))!;
      await mail().processQueue(200);
      let row = await outbox(id);
      expect(row.status).toBe('queued');
      expect(row.attempts).toBe(1);
      expect(row.last_error).toMatch(/^RCPT TO refused: 451/);
      expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 30_000);
      const warn = await db.query(`SELECT level::text AS level, context FROM system_log WHERE context ->> 'mail_id' = $1 AND message = 'mail delivery failed, retrying'`, [id]);
      expect(warn.rows[0].level).toBe('warn');
      expect(warn.rows[0].context.retry_in_minutes).toBe(1);
      code = 250;
      await makeDue(id);
      await mail().processQueue(200);
      row = await outbox(id);
      expect(row.status).toBe('sent');
      expect(row.attempts).toBe(2);

      code = 550;
      const dead = (await mail().sendToUser(u.id, { kind: 'identity.notice', subject: 'No such user', text: 'x' }))!;
      await mail().processQueue(200);
      expect((await outbox(dead)).status).toBe('dead');
      const err = await db.query(`SELECT level::text AS level FROM system_log WHERE context ->> 'mail_id' = $1 AND message = 'mail given up'`, [dead]);
      expect(err.rows[0].level).toBe('error');
      const notes = await db.query(`SELECT count(*) FROM notifications WHERE kind = 'system' AND link = '/admin/mail' AND created_at > now() - interval '1 hour'`);
      expect(Number(notes.rows[0].count)).toBeGreaterThan(0);
      // the notice about a failed mail is never mailed itself
      expect((await db.query(`SELECT count(*) FROM mail_outbox WHERE kind = 'notification.system'`)).rows[0].count).toBe('0');
    } finally {
      Object.assign((mail() as unknown as { cfg: MailConfig }).cfg, saved);
      await flaky.close();
    }
  });

  it('gives up after the last step of mail.retry_minutes', async () => {
    const u = await makeUser(db, { assigned: true });
    await setSetting('mail.retry_minutes', [1]);
    const flaky = new FakeSmtp({ rcptCode: () => 451 });
    await flaky.listen();
    const saved = { ...mailCfg };
    Object.assign((mail() as unknown as { cfg: MailConfig }).cfg, { port: flaky.port, user: undefined, pass: undefined });
    try {
      const id = (await mail().sendToUser(u.id, { kind: 'identity.notice', subject: 'Two tries', text: 'x' }))!;
      await mail().processQueue(200);
      expect((await outbox(id)).status).toBe('queued');
      await makeDue(id);
      await mail().processQueue(200);
      const row = await outbox(id);
      expect(row.status).toBe('dead');
      expect(row.attempts).toBe(2);
    } finally {
      Object.assign((mail() as unknown as { cfg: MailConfig }).cfg, saved);
      await setSetting('mail.retry_minutes', [1, 5, 15, 60, 240]);
      await flaky.close();
    }
  });

  it('suppresses mails above the hourly cap of one address', async () => {
    const u = await makeUser(db, { assigned: true });
    await setSetting('mail.cap_per_recipient_per_hour', 2);
    try {
      const ids = [];
      for (let i = 0; i < 3; i++) ids.push((await mail().sendToUser(u.id, { kind: 'identity.notice', subject: `n${i}`, text: 'x' }))!);
      expect((await outbox(ids[2]!)).status).toBe('suppressed');
      expect((await deliveredTo(u.email)).length).toBe(2);
    } finally {
      await setSetting('mail.cap_per_recipient_per_hour', 30);
    }
  });

  it('a mail to an address needs a signed-in actor; security_alert is reserved for the database', async () => {
    await expect(mail().sendToAddress('new.address@example.test', { kind: 'identity.email_verify', subject: 's', text: 't' })).rejects.toThrow(/no signed-in actor/);
    const u = await makeUser(db, { assigned: true });
    await expect(mail().sendToUser(u.id, { kind: 'security_alert', subject: 's', text: 't' })).rejects.toThrow(/reserved/);
    // an inactive or unknown user gets nothing
    expect(await mail().sendToUser('00000000-0000-4000-8000-000000000001', { kind: 'identity.notice', subject: 's', text: 't' })).toBeNull();
  });

  it('pmis_app cannot read, change or empty the outbox directly', async () => {
    const app2 = new PgClient({ connectionString: process.env.TEST_DATABASE_URL_P9M });
    await app2.connect();
    try {
      await expect(app2.query('SELECT count(*) FROM mail_outbox')).rejects.toThrow(/permission denied/);
      await expect(app2.query(`UPDATE mail_outbox SET status = 'sent'`)).rejects.toThrow(/permission denied/);
      await expect(app2.query(`DELETE FROM mail_outbox`)).rejects.toThrow(/permission denied/);
    } finally {
      await app2.end();
    }
  });
});

describe('security alerts and notifications by mail', () => {
  it('mails every active System Admin with the rule, the severity and the link, never the alert data', async () => {
    const { admin } = await adminApi(app, db);
    const dedup = `p9-test:${Date.now()}:${Math.random()}`;
    await db.query(`SELECT sec_alert_raise('admin_set_changed', 'high', 'The System Admins changed', '{"secret_detail": "do-not-mail"}'::jsonb, $1)`, [dedup]);
    const alert = (await db.query('SELECT id, severity FROM security_alerts WHERE dedup_key = $1', [dedup])).rows[0];
    expect(alert.severity).toBe('high');
    const got = (await deliveredTo(admin.email)).filter((m) => m.text.includes(alert.id));
    expect(got).toHaveLength(1);
    expect(got[0]!.subject).toBe('[PMIS] HIGH security alert: The System Admins changed');
    expect(got[0]!.text).toContain(`https://pmis.aljeel.test/admin/security-alerts?id=${alert.id}`);
    expect(got[0]!.text).toContain('Rule: admin_set_changed');
    expect(got[0]!.text).not.toContain('do-not-mail');
    const rows = await db.query(`SELECT count(*) FROM mail_outbox WHERE kind = 'security_alert' AND source ->> 'alert_id' = $1`, [alert.id]);
    const admins = await db.query(`SELECT count(DISTINCT gm.user_id) FROM group_members gm JOIN groups g ON g.id = gm.group_id AND g.is_system_admins AND g.is_active
      JOIN users u ON u.id = gm.user_id AND u.status = 'active'`);
    expect(rows.rows[0].count).toBe(admins.rows[0].count);
  });

  it('mails from email_min_severity up; the mandatory rules stay critical', async () => {
    const cur = (await db.query(`SELECT value FROM settings WHERE key = 'security_alerts'`)).rows[0]?.value ?? {};
    await setSetting('security_alerts', { ...cur, email_min_severity: 'critical', severity: { admin_set_changed: 'medium' } });
    try {
      const d1 = `p9-min:${Date.now()}:1`;
      const d2 = `p9-min:${Date.now()}:2`;
      await db.query(`SELECT sec_alert_raise('admin_set_changed', 'high', 'below the floor', NULL, $1)`, [d1]);
      await db.query(`SELECT sec_alert_raise('audit_integrity_failure', 'low', 'always critical', NULL, $1)`, [d2]);
      const a1 = (await db.query('SELECT id, severity FROM security_alerts WHERE dedup_key = $1', [d1])).rows[0];
      const a2 = (await db.query('SELECT id, severity FROM security_alerts WHERE dedup_key = $1', [d2])).rows[0];
      expect(a1.severity).toBe('medium');
      expect(a2.severity).toBe('critical');
      expect((await db.query(`SELECT count(*) FROM mail_outbox WHERE source ->> 'alert_id' = $1`, [a1.id])).rows[0].count).toBe('0');
      expect(Number((await db.query(`SELECT count(*) FROM mail_outbox WHERE source ->> 'alert_id' = $1 AND (source ->> 'mandatory')::boolean`, [a2.id])).rows[0].count)).toBeGreaterThan(0);
    } finally {
      await setSetting('security_alerts', cur);
    }
  });

  it('a notification kind listed in mail.notification_kinds is also mailed to its recipient', async () => {
    const u = await makeUser(db, { assigned: true });
    await db.query(`INSERT INTO notifications (user_id, kind, title, body, link) VALUES ($1, 'task_assigned', 'Not mailed yet', 'b', '/tasks/1')`, [u.id]);
    expect((await db.query(`SELECT count(*) FROM mail_outbox WHERE to_user_id = $1`, [u.id])).rows[0].count).toBe('0');
    await setSetting('mail.notification_kinds', ['task_assigned']);
    try {
      await db.query(`INSERT INTO notifications (user_id, kind, title, body, link) VALUES ($1, 'task_assigned', 'Task B5 is yours', 'Site TR-0001', '/tasks/2')`, [u.id]);
      const got = await deliveredTo(u.email);
      expect(got).toHaveLength(1);
      expect(got[0]!.subject).toBe('[PMIS] Task B5 is yours');
      expect(got[0]!.text).toContain('Open: https://pmis.aljeel.test/tasks/2');
    } finally {
      await setSetting('mail.notification_kinds', []);
    }
  });
});

describe('the admin endpoints and the health check', () => {
  it('reports the channel as unverified until a test mail went out, then verified; the test is audited', async () => {
    const { admin, api } = await adminApi(app, db);
    let st = await api.call('get', '/admin/mail/status');
    expect(st.status).toBe(200);
    expect(st.body).toMatchObject({ enabled: true, settings: { host: '127.0.0.1', port: fake.port, tls: 'none', from: 'GSDN PMIS <pmis@aljeel.test>', auth: true } });
    expect(JSON.stringify(st.body)).not.toContain('relay-secret');
    expect(['unverified', 'verified', 'failing']).toContain(st.body.state);
    const t = await api.call('post', '/admin/mail/test');
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ outcome: 'sent', error: null, to: `${admin.email[0]}***@example.test` });
    expect(fake.received.some((m) => m.to.includes(admin.email) && m.subject.startsWith('[PMIS] Test mail'))).toBe(true);
    st = await api.call('get', '/admin/mail/status');
    expect(st.body.verified_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((await db.query(`SELECT count(*) FROM audit_log WHERE action = 'mail_test_sent' AND actor_id = $1`, [admin.id])).rows[0].count).toBe('1');
  });

  it('lists the outbox without bodies, hides a sensitive subject, and puts a given-up mail back with a reason', async () => {
    const { api } = await adminApi(app, db);
    const u = await makeUser(db, { assigned: true });
    const sid = (await mail().sendToUser(u.id, { kind: 'identity.email_verify', subject: 'Confirm your new address', text: 'token=abc123', sensitive: true }))!;
    const list = await api.call('get', '/admin/mail/outbox?limit=200');
    expect(list.status).toBe(200);
    const row = list.body.items.find((x: { id: string }) => x.id === sid);
    expect(row).toMatchObject({ kind: 'identity.email_verify', subject: '(hidden)', sensitive: true, status: 'queued' });
    expect(JSON.stringify(list.body)).not.toContain('token=abc123');
    expect((await api.call('get', '/admin/mail/outbox?status=nope')).status).toBe(422);
    await mail().processQueue(200);
    const dead = (await db.query(`SELECT id FROM mail_outbox WHERE status = 'dead' ORDER BY created_at DESC LIMIT 1`)).rows[0].id as string;
    expect((await api.call('post', `/admin/mail/outbox/${dead}/retry`, {})).status).toBe(422);
    const r = await api.call('post', `/admin/mail/outbox/${dead}/retry`, { reason: 'relay fixed' });
    expect(r.status).toBe(200);
    expect((await outbox(dead)).status).toBe('queued');
    expect((await db.query(`SELECT reason FROM audit_log WHERE action = 'mail_retry' AND entity_id = $1`, [dead])).rows[0].reason).toBe('relay fixed');
    expect((await api.call('post', `/admin/mail/outbox/${dead}/retry`, { reason: 'twice' })).status).toBe(409);
    await mail().processQueue(200);
  });

  it('refuses the mail screens to a user without the right', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    expect((await api.call('get', '/admin/mail/status')).status).toBe(403);
    expect((await api.call('get', '/admin/mail/outbox')).status).toBe(403);
    expect((await api.call('post', '/admin/mail/test')).status).toBe(403);
  });

  it('GET /health needs no session and answers words only', async () => {
    const r = await request(app.getHttpServer()).get(`${API}/health`);
    expect(r.status).toBe(200);
    expect(r.body.checks.database).toBe('ok');
    expect(['ok', 'disabled', 'unverified', 'failing']).toContain(r.body.checks.mail);
    expect(['ok', 'degraded']).toContain(r.body.status);
    expect(JSON.stringify(r.body)).not.toMatch(/@|relay|127\.0\.0\.1/);
  });
});

describe('without SMTP the service records what it would have sent', () => {
  let off: NestExpressApplication;
  beforeAll(async () => {
    await mail().processQueue(200);   // nothing of the suites above is left for the second app
    off = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_P9M as string });
  });
  afterAll(async () => {
    await off.close();
  });

  it('marks the mail logged, writes the System Log row with the subject and never connects', async () => {
    const u = await makeUser(db, { assigned: true });
    const before = fake.received.length;
    const svc = off.get(MailService);
    expect(svc.enabled).toBe(false);
    const id = (await svc.sendToUser(u.id, { kind: 'identity.notice', subject: 'Would be sent', text: 'body text' }))!;
    await svc.processQueue(200);
    expect((await outbox(id)).status).toBe('logged');
    const log = await db.query(`SELECT context FROM system_log WHERE context ->> 'mail_id' = $1 AND message = 'mail not sent: SMTP is not configured'`, [id]);
    expect(log.rows[0].context).toMatchObject({ kind: 'identity.notice', subject: 'Would be sent' });
    expect(JSON.stringify(log.rows[0].context)).not.toContain('body text');
    expect(fake.received.length).toBe(before);
  });

  it('the test endpoint answers 422 mail_not_configured and the status says disabled', async () => {
    const { api } = await adminApi(off, db);
    const t = await api.call('post', '/admin/mail/test');
    expect(t.status).toBe(422);
    expect(t.body.code).toBe('mail_not_configured');
    const st = await api.call('get', '/admin/mail/status');
    expect(st.body).toMatchObject({ enabled: false, state: 'disabled', settings: null });
  });
});
