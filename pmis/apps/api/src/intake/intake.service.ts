import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { RateLimiter } from '../auth/rate-limiter';
import { mapDbError } from '../common/db-errors';
import { parseIfMatch } from '../common/etag';
import { ProblemException, problems } from '../common/problem';
import { parse } from '../common/zod';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DbService } from '../db/db.service';
import { applyContext } from '../logs/context';
import { SecurityLocksService } from '../security/security-locks.service';

type Json = Record<string, unknown>;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');
const PLAIN = /[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]|&(#[0-9]+|#x[0-9a-f]+|[a-z]+);/i;

const formBody = z.object({
  name: z.string().trim().min(1).max(80),
  register_key: z.string().min(1).max(60),
  site_id: z.guid(),
  record_type: z.string().min(1).max(40).nullable().optional(),
  field_codes: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,40}$/)).min(1).max(20),
  fixed: z.record(z.string(), z.union([z.string().max(2000), z.number(), z.boolean()])).optional(),
  intro_en: z.string().trim().max(600).nullable().optional(),
  intro_ar: z.string().trim().max(600).nullable().optional(),
  thanks_en: z.string().trim().max(300).nullable().optional(),
  thanks_ar: z.string().trim().max(300).nullable().optional(),
  expires_at: z.iso.datetime({ offset: true }).nullable().optional(),
  max_per_hour: z.number().int().min(1).max(500).optional(),
  ask_contact: z.boolean().optional(),
}).strict();
const patchBody = formBody.omit({ register_key: true, site_id: true }).partial().extend({ is_active: z.boolean().optional() }).strict();

const submitBody = z.object({
  values: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,40}$/), z.union([z.string().max(4000), z.number(), z.boolean(), z.null()])),
  reporter_name: z.string().trim().max(120).optional(),
  reporter_contact: z.string().trim().max(160).optional(),
  website: z.string().max(200).optional(), // the honeypot: hidden on the page, a person leaves it empty
}).strict();

interface FieldDef { code: string; label_en: string; label_ar: string | null; type: string; required: boolean; options: string[] | null }
interface PeekRow { id: string; owner_id: string; register_key: string; site_id: string; record_type: string | null; fixed: Json; ask_contact: boolean; fields: FieldDef[]; [k: string]: unknown }

/** Migration 0730 (contract tag `intake`): the forms a manager makes. The database checks who may (the owner must hold the create right and be an entry holder). */
@Injectable()
export class IntakeFormsService {
  constructor(private readonly db: DbService, private readonly locks: SecurityLocksService) {}

  private static token(): { token: string; hash: string; hint: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: sha256Hex(token), hint: token.slice(-4) };
  }

  private async guard<T>(name: string, fn: () => Promise<T>): Promise<T> {
    await this.db.tx.$executeRaw(Prisma.sql`SAVEPOINT ${Prisma.raw(name)}`);
    try {
      const r = await fn();
      await this.db.tx.$executeRaw(Prisma.sql`RELEASE SAVEPOINT ${Prisma.raw(name)}`);
      return r;
    } catch (e) {
      if (e instanceof ProblemException) throw e;
      const p = mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw(Prisma.sql`ROLLBACK TO SAVEPOINT ${Prisma.raw(name)}`);
      throw p;
    }
  }

  async list(): Promise<Json> {
    const r = await this.db.tx.$queryRaw<{ j: Json }[]>(Prisma.sql`SELECT intake_forms_json() AS j`);
    return r[0]!.j;
  }

  private async one(id: string): Promise<Json> {
    const items = ((await this.list()).items as Json[]) ?? [];
    const f = items.find((x) => x.id === id);
    if (!f) throw new ProblemException(404, 'not_found', { detail: 'The form does not exist or is not visible to you.' });
    return f;
  }

  async create(rawBody: unknown): Promise<Json> {
    const b = parse(formBody, rawBody);
    this.plain(b);
    await this.locks.assertSharingAllowed();
    const t = IntakeFormsService.token();
    const id = await this.guard('intake_save', async () => {
      const r = await this.db.tx.$queryRaw<{ r: string }[]>(Prisma.sql`SELECT intake_form_save(NULL::uuid, NULL::int, ${JSON.stringify(b)}::jsonb, ${t.hash}::text, ${t.hint}::text)::text AS r`);
      return r[0]!.r;
    });
    return { ...(await this.one(id)), token: t.token };
  }

  async update(id: string, ifMatch: string | undefined, rawBody: unknown): Promise<Json> {
    const version = parseIfMatch(ifMatch);
    const b = parse(patchBody, rawBody);
    this.plain(b);
    if (b.is_active === true) await this.locks.assertSharingAllowed();
    await this.guard('intake_save', () => this.db.tx.$queryRaw(Prisma.sql`SELECT intake_form_save(${id}::uuid, ${version}::int, ${JSON.stringify(b)}::jsonb, NULL::text, NULL::text)`));
    return this.one(id);
  }

  /** A new link: the old one stops working at once. The token is in this answer only. */
  async replaceLink(id: string, ifMatch: string | undefined): Promise<Json> {
    const version = parseIfMatch(ifMatch);
    await this.locks.assertSharingAllowed();
    const t = IntakeFormsService.token();
    await this.guard('intake_save', () => this.db.tx.$queryRaw(Prisma.sql`SELECT intake_form_save(${id}::uuid, ${version}::int, '{}'::jsonb, ${t.hash}::text, ${t.hint}::text)`));
    return { ...(await this.one(id)), token: t.token };
  }

  async remove(id: string): Promise<void> {
    await this.guard('intake_del', () => this.db.tx.$queryRaw(Prisma.sql`SELECT intake_form_delete(${id}::uuid)`));
  }

  async submissions(id: string): Promise<Json> {
    const r = await this.guard('intake_subs', () => this.db.tx.$queryRaw<{ j: unknown }[]>(Prisma.sql`SELECT intake_submissions_json(${id}::uuid) AS j`));
    return { items: r[0]!.j };
  }

  private plain(b: Json): void {
    const bad: { path: string; code: string; message: string }[] = [];
    for (const k of ['name', 'intro_en', 'intro_ar', 'thanks_en', 'thanks_ar']) {
      const v = b[k];
      if (typeof v === 'string' && PLAIN.test(v)) bad.push({ path: `/${k}`, code: 'markup_not_allowed', message: 'Write plain text: the characters < and > and HTML entities are not accepted.' });
    }
    if (bad.length) throw new ProblemException(422, 'validation_failed', { detail: 'Check the form.', errors: bad });
  }
}

/** The public side (no session). Every failure that could tell a stranger something answers the same 404. */
@Injectable()
export class PublicIntakeService {
  constructor(private readonly db: DbService, private readonly limiter: RateLimiter, @Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private static gone(): ProblemException {
    return new ProblemException(404, 'not_found', { detail: 'This form is not available. Ask the person who sent you the link.' });
  }

  private async peek(token: string): Promise<PeekRow | null> {
    if (!TOKEN_RE.test(token)) return null;
    const r = await this.db.client.$queryRaw<{ j: PeekRow | null }[]>(Prisma.sql`SELECT intake_form_peek(${sha256Hex(token)}::text) AS j`);
    return r[0]?.j ?? null;
  }

  private sender(ip: string | null, formId: string): string {
    return createHmac('sha256', this.config.LOG_HMAC_KEY).update(`intake:${formId}:${ip ?? 'unknown'}`).digest('hex');
  }

  /** What the page needs: the name, the texts and the asked fields. Never the site, the register, the owner or any record. */
  async form(token: string, ip: string | null): Promise<Json> {
    const wait = this.limiter.hit(`intake:peek:${ip ?? 'unknown'}`, 60, 60_000);
    if (wait) throw problems.rateLimited(wait);
    const f = await this.peek(token);
    if (!f) throw PublicIntakeService.gone();
    return {
      name: f.name, intro_en: f.intro_en, intro_ar: f.intro_ar, ask_contact: f.ask_contact,
      fields: f.fields.map((x) => ({ code: x.code, label_en: x.label_en, label_ar: x.label_ar, type: x.type, required: x.required, options: x.options })),
    };
  }

  async submit(token: string, ip: string | null, ua: string | null, raw: unknown): Promise<Json> {
    const wait = this.limiter.hit(`intake:submit:${ip ?? 'unknown'}`, 10, 3_600_000);
    if (wait) throw problems.rateLimited(wait);
    const b = parse(submitBody, raw);
    const f = await this.peek(token);
    if (!f) throw PublicIntakeService.gone();
    const thanks = { ok: true, thanks_en: f.thanks_en ?? null, thanks_ar: f.thanks_ar ?? null };
    if (b.website && b.website.trim() !== '') return thanks; // honeypot: a bot filled the hidden field; it is told it worked and nothing is written
    const data = this.clean(f, b.values);
    const sender = this.sender(ip, f.id);
    const sec = await this.db.client.$queryRaw<{ w: number }[]>(Prisma.sql`SELECT intake_quota_wait(${f.id}::uuid, ${sender}::text) AS w`);
    if (sec[0] && sec[0].w > 0) throw problems.rateLimited(sec[0].w);
    try {
      await this.db.client.$transaction(async (tx) => {
        await applyContext(tx, { ip, userAgent: ua, requestId: null, via: 'api', userId: f.owner_id });
        await this.db.runIn(tx, async () => {
          const rid = await this.db.tx.$queryRaw<{ r: string }[]>(Prisma.sql`SELECT reg_save_record(${f.register_key}::text, NULL::uuid, NULL::int, ${f.site_id}::uuid, ${f.record_type}::text,
            ${JSON.stringify(data)}::jsonb, NULL::jsonb, NULL::uuid, false)::text AS r`);
          await this.db.tx.$executeRaw(Prisma.sql`SELECT intake_submission_log(${f.id}::uuid, ${rid[0]!.r}::uuid, ${sender}::text, ${b.reporter_name ?? null}::text, ${f.ask_contact ? b.reporter_contact ?? null : null}::text)`);
        });
      }, { maxWait: 10_000, timeout: 30_000 });
    } catch (e) {
      if (e instanceof ProblemException && e.getStatus() === 422) throw e;
      // the owner lost the right, the register changed, the site is gone: the sender learns nothing about why
      const p = mapDbError(e);
      if (p && p.getStatus() === 422) throw p;
      throw PublicIntakeService.gone();
    }
    return thanks;
  }

  /** Only the asked fields count (a hidden or unknown key is dropped), each checked by its type; the form's own presets are laid over them. */
  private clean(f: PeekRow, values: Record<string, string | number | boolean | null>): Json {
    const errors: { path: string; code: string; message: string }[] = [];
    const out: Json = {};
    for (const fd of f.fields) {
      const v = values[fd.code];
      const blank = v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
      if (blank) {
        if (fd.required) errors.push({ path: `/values/${fd.code}`, code: 'required', message: 'Required.' });
        continue;
      }
      const path = `/values/${fd.code}`;
      if (fd.type === 'number') {
        const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
        if (!Number.isFinite(n)) errors.push({ path, code: 'invalid', message: 'A number.' }); else out[fd.code] = n;
      } else if (fd.type === 'yes_no') {
        if (typeof v === 'boolean') out[fd.code] = v; else if (v === 'yes' || v === 'no') out[fd.code] = v === 'yes'; else errors.push({ path, code: 'invalid', message: 'Yes or no.' });
      } else if (fd.type === 'date') {
        if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v))) out[fd.code] = v; else errors.push({ path, code: 'invalid', message: 'A date (YYYY-MM-DD).' });
      } else {
        const t = String(v).trim();
        if (PLAIN.test(t)) errors.push({ path, code: 'markup_not_allowed', message: 'Write plain text.' });
        else if (fd.type === 'list' && fd.options && !fd.options.includes(t)) errors.push({ path, code: 'not_in_list', message: 'Choose one of the options.' });
        else out[fd.code] = t;
      }
    }
    if (errors.length) throw new ProblemException(422, 'validation_failed', { detail: 'Check the form.', errors });
    const today = new Date().toISOString().slice(0, 10);
    for (const [k, v] of Object.entries(f.fixed ?? {})) out[k] = v === '@today' ? today : v;
    return out;
  }
}
