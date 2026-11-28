import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { parseIfMatch } from '../common/etag';
import { problems } from '../common/problem';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';

const code = z.string().regex(/^[a-z0-9_]{2,30}$/);
const fieldDef = z.object({
  key: code, label_en: z.string().trim().min(1).max(80), label_ar: z.string().trim().max(80),
  type: z.enum(['text', 'longtext', 'number', 'yesno', 'choice']), required: z.boolean(), options: z.array(z.string().trim().min(1).max(60)).max(20),
}).strict();
const formDef = z.object({
  code, name_en: z.string().trim().min(1).max(80), name_ar: z.string().trim().max(80), enabled: z.boolean(), signature: z.boolean(), fields: z.array(fieldDef).max(30),
}).strict();
const putBody = z.object({ forms: z.array(formDef).max(20), reason: z.string().trim().min(3).max(1000) }).strict();

const uuid = z.string().uuid();
const submitBody = z.object({
  client_id: uuid, form_code: code, answers: z.record(z.string(), z.unknown()),
  signature: z.string().max(300000).regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/).nullable().optional(),
  signer_name: z.string().trim().min(1).max(120).nullable().optional(),
  captured_at: z.string().datetime({ offset: true }),
}).strict();

export interface FieldFormField { key: string; label_en: string; label_ar: string; type: 'text' | 'longtext' | 'number' | 'yesno' | 'choice'; required: boolean; options: string[] }
export interface FieldForm { code: string; name_en: string; name_ar: string; enabled: boolean; signature: boolean; fields: FieldFormField[] }
export interface FieldFormsDto {
  forms: FieldForm[]; updated_at: string | null; updated_by: { id: string; display_name: string; employee_id: string | null } | null; version: number; can_edit: boolean;
}

/** The answers against the form kind: every key is a field of the kind, required ones are filled, a value has the type of its field. Returns the error list (empty = fine). */
export function checkAnswers(form: FieldForm, answers: Record<string, unknown>): { path: string; code: string; message: string }[] {
  const errs: { path: string; code: string; message: string }[] = [];
  const keys = new Set(form.fields.map((f) => f.key));
  for (const k of Object.keys(answers)) if (!keys.has(k)) errs.push({ path: `/answers/${k}`, code: 'unknown_field', message: 'Not a field of this form.' });
  for (const f of form.fields) {
    const v = answers[f.key];
    const empty = v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    if (empty) { if (f.required) errs.push({ path: `/answers/${f.key}`, code: 'required', message: 'Required.' }); continue; }
    const bad = (m: string) => errs.push({ path: `/answers/${f.key}`, code: 'invalid', message: m });
    if (f.type === 'text') { if (typeof v !== 'string' || v.length > 200) bad('Text up to 200 characters.'); }
    else if (f.type === 'longtext') { if (typeof v !== 'string' || v.length > 4000) bad('Text up to 4000 characters.'); }
    else if (f.type === 'number') { if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e12) bad('A number.'); }
    else if (f.type === 'yesno') { if (typeof v !== 'boolean') bad('Yes or no.'); }
    else if (typeof v !== 'string' || !f.options.includes(v)) bad('One of the listed options.');
  }
  return errs;
}

/**
 * Offline field forms (migration 0667, contract 0.15.596). The kinds are an admin setting; a filled form is one row (answers, the signature drawn on the device, the signer),
 * sent from the Field outbox with its action id as client_id, so a replay never writes twice. Rights: reading the kinds is for every signed-in user; filling and reading the
 * forms of a site needs the view right on the site's region (checked in the database).
 */
@Injectable()
export class FieldFormsService {
  constructor(private readonly db: DbService, private readonly access: AccessService, private readonly stepUp: StepUpService) {}

  private async one<T>(sql: Prisma.Sql): Promise<T> {
    const rows = await this.db.tx.$queryRaw<{ r: T }[]>(sql);
    return rows[0]!.r;
  }

  get(): Promise<FieldFormsDto> {
    return this.one(Prisma.sql`SELECT field_forms_state() AS r`);
  }

  async set(auth: AuthContext, ifMatch: string | undefined, raw: unknown): Promise<FieldFormsDto> {
    const { reason, ...body } = parse(putBody, raw);
    await this.access.requireAdmin('settings', 'edit');
    const etag = parseIfMatch(ifMatch);
    await this.stepUp.require(auth);
    return this.one(Prisma.sql`SELECT admin_set_field_forms(${JSON.stringify(body)}::jsonb, ${reason}::text, ${etag}::int) AS r`);
  }

  async submit(siteId: string, raw: unknown): Promise<{ id: string; replayed: boolean; submitted_at: string }> {
    if (!uuid.safeParse(siteId).success) throw problems.validation([{ path: '/site_id', code: 'invalid', message: 'A site id.' }]);
    const b = parse(submitBody, raw);
    const cfg = await this.get();
    const form = cfg.forms.find((f) => f.code === b.form_code);
    if (!form || !form.enabled) throw problems.validation([{ path: '/form_code', code: 'unknown_form', message: 'This form is not available.' }]);
    const errs = checkAnswers(form, b.answers);
    if (form.signature && (!b.signature || !b.signer_name)) errs.push({ path: '/signature', code: 'required', message: 'This form needs the signer name and a signature.' });
    if (!form.signature && b.signature) errs.push({ path: '/signature', code: 'invalid', message: 'This form takes no signature.' });
    if (errs.length) throw problems.validation(errs);
    return this.one(Prisma.sql`SELECT field_form_submit(${siteId}::uuid, ${b.client_id}::uuid, ${b.form_code}::text, ${JSON.stringify(b.answers)}::jsonb, ${b.signature ?? null}::text,
      ${b.signer_name ?? null}::text, ${b.captured_at}::timestamptz) AS r`);
  }

  async ofSite(siteId: string): Promise<{ items: unknown[] }> {
    if (!uuid.safeParse(siteId).success) throw problems.validation([{ path: '/site_id', code: 'invalid', message: 'A site id.' }]);
    return { items: await this.one<unknown[]>(Prisma.sql`SELECT field_forms_of_site(${siteId}::uuid) AS r`) };
  }

  async signature(id: string): Promise<{ signature: string }> {
    if (!uuid.safeParse(id).success) throw problems.validation([{ path: '/id', code: 'invalid', message: 'A form id.' }]);
    return { signature: await this.one<string>(Prisma.sql`SELECT field_form_signature(${id}::uuid) AS r`) };
  }
}
