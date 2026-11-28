import { Injectable, StreamableFile } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { mapDbError } from '../common/db-errors';
import { parseIfMatch } from '../common/etag';
import { ProblemException, problems } from '../common/problem';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { attachmentHeader, cleanOriginalName } from '../documents/naming';
import { sniff } from '../documents/sniff';
import { StorageService, newObjectKey } from '../documents/storage.service';

type Json = Record<string, unknown>;
export const COMPANY_FILE_MAX_BYTES = 25 * 1024 * 1024;
const flag = z.preprocess((v) => (v === 'true' || v === '1' ? true : v === 'false' || v === '0' ? false : v), z.boolean());
const text = (n: number) => z.string().trim().max(n);
const contactBody = z.object({
  name: text(120).min(1).optional(), role: text(120).nullable().optional(), phone: text(40).nullable().optional(), email: text(200).nullable().optional(),
  is_primary: flag.optional(), is_active: flag.optional(),
}).strict();
const docBody = z.object({
  type_code: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/).optional(), title: text(160).nullable().optional(), doc_number: text(80).nullable().optional(),
  issued_on: z.string().nullable().optional(), expires_on: z.string().nullable().optional(), notes: text(2000).nullable().optional(), is_active: flag.optional(),
}).strict();
const typesBody = z.object({
  reason: z.string().trim().min(3).max(1000),
  types: z.array(z.object({
    code: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), label_en: text(80).min(1), label_ar: text(80).nullable().optional(), required_for: z.array(z.string().max(40)).max(20).optional(),
    lead_days: z.number().int().min(0).max(365).optional(), has_expiry: z.boolean().optional(), is_active: z.boolean().optional(),
  }).strict()).max(60),
}).strict();

/**
 * Companies proposal K3 (migration 0745): the contacts, the documents and certificates with expiry, and the document types of a contractor company
 * (a row of external_parties). Read: the Contractors or Procurement screens. Write: an editor of Contractors or Procurement. Types: Settings (admin.settings).
 * The file goes through the same store as every document (type sniff, size, virus scan, encryption), and the database writes the audit.
 */
@Injectable()
export class CompanyRecordsService {
  constructor(private readonly db: DbService, private readonly access: AccessService, private readonly storage: StorageService) {}

  private async door(sql: Prisma.Sql): Promise<unknown> {
    await this.db.tx.$executeRaw`SAVEPOINT company_rec`;
    try {
      const rows = await this.db.tx.$queryRaw<{ r: unknown }[]>(sql);
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT company_rec`;
      return rows[0]?.r ?? null;
    } catch (e) {
      if (e instanceof ProblemException) throw e;
      const p = mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT company_rec`;
      throw p;
    }
  }

  private async canRead(auth: AuthContext) { await this.access.requireAnyModuleView(auth, ['contractors', 'procurement']); }
  private async canWrite() {
    for (const m of ['contractors', 'procurement']) {
      const r = await this.access.regions(m, 'edit');
      if (r === null || r.length > 0) return;
    }
    throw new ProblemException(403, 'module_forbidden', { detail: 'You cannot edit companies.' });
  }
  private id(v: string) {
    if (!uuidSchema.safeParse(v).success) throw problems.notFound();
    return v;
  }
  private ver(ifMatch: string | undefined) { return ifMatch === undefined || ifMatch.trim() === '' ? null : parseIfMatch(ifMatch); }

  // ----------------------------------------------------------------------------------------------------------------- settings
  async types(auth: AuthContext): Promise<Json> {
    await this.access.requireModuleView(auth, 'admin.settings');
    return (await this.door(Prisma.sql`SELECT company_doc_types_json() AS r`)) as Json;
  }

  async saveTypes(ifMatch: string | undefined, raw: unknown): Promise<Json> {
    await this.access.requireAdmin('admin.settings', 'edit');
    const b = parse(typesBody, raw);
    return (await this.door(Prisma.sql`SELECT admin_save_company_doc_types(${JSON.stringify(b.types)}::jsonb, ${b.reason}::text, ${this.ver(ifMatch)}::int) AS r`)) as Json;
  }

  // ----------------------------------------------------------------------------------------------------------------- contacts
  async contacts(auth: AuthContext, party: string) {
    await this.canRead(auth);
    return { items: await this.door(Prisma.sql`SELECT company_contacts_list(${this.id(party)}::uuid) AS r`) };
  }

  async saveContact(party: string, contactId: string | null, ifMatch: string | undefined, raw: unknown): Promise<Json> {
    await this.canWrite();
    const b = parse(contactBody, raw);
    return (await this.door(Prisma.sql`SELECT company_contact_save(${this.id(party)}::uuid, ${contactId === null ? null : this.id(contactId)}::uuid, ${JSON.stringify(b)}::jsonb, ${this.ver(ifMatch)}::int) AS r`)) as Json;
  }

  // ----------------------------------------------------------------------------------------------------------------- documents
  async documents(auth: AuthContext, party: string) {
    await this.canRead(auth);
    return { items: await this.door(Prisma.sql`SELECT company_documents_list(${this.id(party)}::uuid) AS r`) };
  }

  async saveDocument(party: string, docId: string | null, ifMatch: string | undefined, raw: unknown, file: { buffer: Buffer; originalname: string } | undefined): Promise<Json> {
    await this.canWrite();
    const b = parse(docBody, raw ?? {});
    const payload: Json = { ...b };
    let key: string | null = null;
    if (file) {
      if (file.buffer.length > COMPANY_FILE_MAX_BYTES) throw new ProblemException(413, 'file_too_large', { detail: `The file is larger than ${COMPANY_FILE_MAX_BYTES / 1024 / 1024} MB.`, extra: { max_size_mb: COMPANY_FILE_MAX_BYTES / 1024 / 1024 } });
      const sn = sniff(file.buffer, file.originalname);
      if (!sn.ok) throw new ProblemException(422, 'file_rejected', { detail: sn.detail, extra: { reason: sn.reason }, errors: [{ path: '/file', code: sn.reason, message: sn.detail }] });
      key = newObjectKey('docs');
      await this.storage.store.put(key, file.buffer);
      payload.file = {
        storage_key: key, original_name: cleanOriginalName(file.originalname) || 'file', mime_type: sn.mime, size_bytes: file.buffer.length,
        sha256: createHash('sha256').update(file.buffer).digest('hex'),
      };
    }
    try {
      return (await this.door(Prisma.sql`SELECT company_document_save(${this.id(party)}::uuid, ${docId === null ? null : this.id(docId)}::uuid, ${JSON.stringify(payload)}::jsonb, ${this.ver(ifMatch)}::int) AS r`)) as Json;
    } catch (e) {
      if (key) await this.storage.store.remove(key).catch(() => undefined);
      throw e;
    }
  }

  async download(auth: AuthContext, party: string, docId: string): Promise<{ file: StreamableFile; headers: Record<string, string> }> {
    await this.canRead(auth);
    const f = (await this.door(Prisma.sql`SELECT company_document_file(${this.id(party)}::uuid, ${this.id(docId)}::uuid) AS r`)) as { storage_key: string; original_name: string; mime_type: string; size_bytes: number };
    const stream = await this.storage.store.get(f.storage_key);
    return {
      file: new StreamableFile(stream, { type: f.mime_type, disposition: attachmentHeader(f.original_name), length: Number(f.size_bytes) }),
      headers: { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' },
    };
  }

  // ----------------------------------------------------------------------------------------------------------------- compliance
  async compliance(auth: AuthContext, party: string): Promise<Json> {
    await this.canRead(auth);
    return (await this.door(Prisma.sql`SELECT company_compliance(${this.id(party)}::uuid) AS r`)) as Json;
  }

  async complianceAll(auth: AuthContext) {
    await this.canRead(auth);
    return { items: await this.door(Prisma.sql`SELECT company_compliance_all() AS r`) };
  }
}
