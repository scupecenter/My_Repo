import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { DbService } from '../db/db.service';
import { ImportService } from '../templates/import.service';
import { TemplatesService } from '../templates/templates.service';

/** Why a batch waits for the caller: send it for approval (the caller uploaded it), review it as L2, or it came back to the caller. `checking` is shown but not counted. */
export type BatchAction = 'send' | 'review_l2' | 'returned' | 'checking';
export interface HubBatch {
  id: string; file_name: string; action: BatchAction; status: string; template_id: string; template_version: number; register_key: string | null; stream: string | null;
  counts: { valid: number; invalid: number }; uploaded_at: string | null; progress_pct: number | null;
}
export interface HubTemplateChange {
  template_id: string; name_en: string; name_ar: string | null; version: number; issued_at: string; reason: string | null;
  added: string[]; removed: string[]; renamed: string[]; my_version: number | null; mine_is_old: boolean;
}
export interface HubDownload { template_id: string; version: number | null; prefill: boolean; at: string }
export interface HubSummary {
  batches: { count: number; items: HubBatch[] };
  template_changes: HubTemplateChange[];
  my_downloads: HubDownload[];
}

const WAITING_STATUSES = ['in_review', 'in_approval', 'partially_approved'] as const;
const CHANGE_WINDOW_DAYS = 45;
const MAX_ITEMS = 5;

/**
 * The Data hub landing page (owner decision 2026-11-27): the pieces that need a rule of their own, in one call. It reuses the batch list and the template catalogue
 * (so the same visibility rules apply: nothing is shown that those screens would not show) and reads the caller's own template downloads from the audit rows every
 * download already writes. The other widgets (exports, integrity, comparison, reset, recycle bin) use the existing endpoints of their screens.
 */
@Injectable()
export class DataHubService {
  constructor(private readonly db: DbService, private readonly access: AccessService, private readonly imports: ImportService, private readonly templates: TemplatesService) {}

  /** The batches that wait for the caller. The count covers what the lists return (up to 200 per status); `checking` uploads are listed, not counted. */
  async batches(auth: AuthContext): Promise<HubSummary['batches']> {
    const tplRegs = await this.access.regions('templates', 'view');
    if (tplRegs !== null && tplRegs.length === 0) return { count: 0, items: [] };
    const mine = auth.user.id;
    const canApprove = new Map<string, boolean>();
    const mayApprove = async (module: string): Promise<boolean> => {
      const hit = canApprove.get(module);
      if (hit !== undefined) return hit;
      const regs = await this.access.regions(module, 'approve');
      const ok = regs === null || regs.length > 0;
      canApprove.set(module, ok);
      return ok;
    };
    const out: HubBatch[] = [];
    const take = async (status: string, decide: (b: Record<string, unknown>) => Promise<BatchAction | null>) => {
      const page = await this.imports.list(auth, { status, limit: '200' });
      for (const raw of page.items as Record<string, unknown>[]) {
        const action = await decide(raw);
        if (action) out.push(this.shape(raw, action));
      }
    };
    const uploader = (b: Record<string, unknown>) => (b.uploaded_by as { id?: string } | undefined)?.id === mine;
    await take('validated', async (b) => (uploader(b) ? 'send' : null));
    await take('rejected', async (b) => (uploader(b) ? 'returned' : null));
    for (const st of WAITING_STATUSES) {
      await take(st, async (b) => {
        const module = (b.stream || b.entity) ? 'sites' : await this.moduleOf(String(b.register_key ?? ''));
        if (module && (await mayApprove(module))) return 'review_l2';
        return null;
      });
    }
    const running = await this.imports.list(auth, { status: 'parsing', limit: '50' });
    const checking = (running.items as Record<string, unknown>[]).filter(uploader).map((b) => this.shape(b, 'checking'));
    const needs = out.sort((a, b) => String(b.uploaded_at ?? '').localeCompare(String(a.uploaded_at ?? '')));
    return { count: needs.length, items: [...needs, ...checking].slice(0, MAX_ITEMS) };
  }

  /** The module a register batch belongs to (the right to approve is checked on it, as the batch decision does). */
  private async moduleOf(registerKey: string): Promise<string | null> {
    if (!registerKey) return null;
    const rows = await this.db.tx.$queryRaw<{ module_key: string }[]>(Prisma.sql`SELECT module_key FROM register_definitions WHERE register_key = ${registerKey}`);
    return rows[0]?.module_key ?? null;
  }

  private shape(b: Record<string, unknown>, action: BatchAction): HubBatch {
    const c = (b.counts ?? {}) as Record<string, number>;
    const prog = b.progress as { rows_done?: number; rows_total?: number } | null | undefined;
    return {
      id: String(b.id), file_name: String(b.file_name ?? ''), action, status: String(b.status), template_id: String(b.template_id ?? ''), template_version: Number(b.template_version ?? 0),
      register_key: (b.register_key as string | null) ?? null, stream: (b.stream as string | null) ?? null,
      counts: { valid: Number(c.create ?? 0) + Number(c.update ?? 0) + Number(c.unchanged ?? 0), invalid: Number(c.error ?? 0) },
      uploaded_at: (b.uploaded_at as string | undefined) ?? null, progress_pct: prog?.rows_total ? Math.min(100, Math.round(((prog.rows_done ?? 0) / prog.rows_total) * 100)) : null,
    };
  }

  /** The caller's last download of each template (a SQL door that reads only the caller's own audit rows). */
  async downloads(limit = 20): Promise<HubDownload[]> {
    const rows = await this.db.tx.$queryRaw<{ r: HubDownload[] }[]>(Prisma.sql`SELECT data_hub_my_downloads(${limit}::int) AS r`);
    return rows[0]?.r ?? [];
  }

  /** Templates whose current version was issued lately and above 1, with the column diff against the version before it. */
  async changes(auth: AuthContext, downloads: HubDownload[]): Promise<HubTemplateChange[]> {
    const list = (await this.templates.list(auth)).items as {
      template_id: string; name_en: string; name_ar: string | null; current_version: number; issued_at: string | Date; versions: { version: number; issued_at: string | Date; reason: string | null }[];
    }[];
    const since = Date.now() - CHANGE_WINDOW_DAYS * 86_400_000;
    const recent = list
      .filter((t) => t.current_version > 1 && new Date(t.issued_at).getTime() >= since)
      .sort((a, b) => new Date(b.issued_at).getTime() - new Date(a.issued_at).getTime())
      .slice(0, MAX_ITEMS);
    const out: HubTemplateChange[] = [];
    for (const t of recent) {
      const compat = await this.templates.compat(t.template_id, t.current_version - 1);
      const mine = downloads.find((d) => d.template_id === t.template_id)?.version ?? null;
      out.push({
        template_id: t.template_id, name_en: t.name_en, name_ar: t.name_ar, version: t.current_version, issued_at: new Date(t.issued_at).toISOString(),
        reason: t.versions.find((v) => v.version === t.current_version)?.reason ?? null,
        added: (compat?.added_columns ?? []).map((c) => c.header ?? c.key), removed: (compat?.removed_columns ?? []).map((c) => c.header ?? c.key),
        renamed: (compat?.renamed_columns ?? []).map((c) => `${c.from ?? ''} > ${c.to ?? ''}`),
        my_version: mine, mine_is_old: mine !== null && mine < t.current_version,
      });
    }
    return out;
  }

  async summary(auth: AuthContext): Promise<HubSummary> {
    const my_downloads = await this.downloads();
    const [batches, template_changes] = [await this.batches(auth), await this.changes(auth, my_downloads)];
    return { batches, template_changes, my_downloads };
  }
}
