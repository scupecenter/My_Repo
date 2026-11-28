import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AccessService } from '../access/access.service';
import { DbService } from '../db/db.service';

/** The Finance hub summary (contract 0.15.361, migration 0406): one card per register, null when the caller cannot view the register's module. */
export interface FinanceHubAdvances {
  open_count: number;
  overdue_count: number;
  /** Total open balance of the advances fin_amounts_visible shows the caller amounts of; null when that is none. */
  open_amount: number | null;
  currency: string;
}
export interface FinanceHubInvoices {
  open_count: number;
  by_state: Record<string, number>;
  aging: { first: number; second: number; third: number };
  overdue_count: number;
}
export interface FinanceHubSummary {
  advances: FinanceHubAdvances | null;
  invoices: FinanceHubInvoices | null;
}

const INV_STATES = ['Received', 'UnderReview', 'Approved', 'Disputed'] as const;
const DEFAULTS = { settle_warn_days: 30, aging_days: [30, 60] as [number, number] };

/**
 * The Finance hub landing page (owner decision D57, 2026-11-27): read-only summary cards over the two separate registers. Every row counted is a row
 * the register screen would show the caller: the register's own module and region visibility (wf_actor_regions through AccessService, like the
 * registers list) and the latest version only. Advance amounts follow fin_amounts_visible(), the rule the register itself applies (0.15.103): the
 * open-balance total covers only the advances whose amounts the caller may see, and is null when there is no such advance, so the card never leaks
 * an amount. The thresholds (advance warning days, invoice aging bounds) come from the finance_hub section of ui.features (the seed when unset).
 */
@Injectable()
export class FinanceHubService {
  constructor(private readonly db: DbService, private readonly access: AccessService) {}

  async summary(): Promise<FinanceHubSummary> {
    const s = await this.settings();
    const [advances, invoices] = await Promise.all([this.advances(s.settle_warn_days), this.invoices(s.aging_days)]);
    return { advances, invoices };
  }

  /** The finance_hub section of ui.features, with the seed as the fallback of each value. */
  private async settings(): Promise<{ settle_warn_days: number; aging_days: [number, number] }> {
    const rows = await this.db.tx.$queryRaw<{ s: { settle_warn_days?: number; aging_days?: number[] } | null }[]>(
      Prisma.sql`SELECT ui_features_json() -> 'sections' -> 'finance_hub' AS s`);
    const s = rows[0]?.s ?? null;
    const aging = Array.isArray(s?.aging_days) && s.aging_days.length === 2 ? ([Number(s.aging_days[0]), Number(s.aging_days[1])] as [number, number]) : DEFAULTS.aging_days;
    const warn = typeof s?.settle_warn_days === 'number' && s.settle_warn_days >= 1 ? s.settle_warn_days : DEFAULTS.settle_warn_days;
    return { settle_warn_days: warn, aging_days: aging };
  }

  /** Latest-version rows of one register, with the region visibility of the register list screen. Null = the module is not the caller's. */
  private async advances(warnDays: number): Promise<FinanceHubAdvances | null> {
    const regs = await this.access.regions('financial_advances', 'view');
    if (regs !== null && regs.length === 0) return null;
    const rows = await this.db.tx.$queryRaw<{ open_count: bigint; overdue_count: bigint; open_amount: string | null }[]>(
      Prisma.sql`SELECT open_count, overdue_count, open_amount FROM finance_hub_advances(${warnDays}::int)`);
    const row = rows[0];
    return { open_count: Number(row?.open_count ?? 0), overdue_count: Number(row?.overdue_count ?? 0), open_amount: row?.open_amount == null ? null : Number(row.open_amount), currency: 'LYD' };
  }

  private async invoices(aging: [number, number]): Promise<FinanceHubInvoices | null> {
    const regs = await this.access.regions('invoices', 'view');
    if (regs !== null && regs.length === 0) return null;
    const vis = regs === null ? Prisma.sql`true` : Prisma.sql`(r.is_global OR r.region_id = ANY(${regs}::int[]))`;
    const rows = await this.db.tx.$queryRaw<{ state: string | null; cnt: bigint; age_days: number | null; overdue: bigint }[]>(Prisma.sql`
      SELECT r.data ->> 'invoice_state' AS state,
             count(*) FILTER (WHERE r.data ->> 'invoice_state' NOT IN ('Paid', 'Cancelled') OR r.data ->> 'invoice_state' IS NULL) AS cnt,
             public.cal_today() - nullif(r.data ->> 'received_date', '')::date AS age_days,
             count(*) FILTER (WHERE (r.data ->> 'invoice_state' NOT IN ('Paid', 'Cancelled') OR r.data ->> 'invoice_state' IS NULL)
                              AND nullif(r.data ->> 'due_date', '')::date < public.cal_today()) AS overdue
      FROM public.register_records r
      WHERE r.register_key = 'invoices' AND ${vis}
        AND NOT EXISTS (SELECT 1 FROM public.register_records n WHERE n.entity_id = r.entity_id AND n.version_no > r.version_no)
      GROUP BY 1, 3`);
    const [b0, b1] = aging;
    const by_state: Record<string, number> = { Received: 0, UnderReview: 0, Approved: 0, Disputed: 0 };
    const buckets = { first: 0, second: 0, third: 0 };
    let open = 0, overdue = 0;
    for (const row of rows) {
      const cnt = Number(row.cnt);
      open += cnt;
      overdue += Number(row.overdue);
      if (row.state && (INV_STATES as readonly string[]).includes(row.state)) by_state[row.state] = (by_state[row.state] ?? 0) + cnt;
      if (row.age_days != null && row.state !== 'Paid' && row.state !== 'Cancelled') {
        if (row.age_days <= b0) buckets.first += cnt;
        else if (row.age_days <= b1) buckets.second += cnt;
        else buckets.third += cnt;
      }
    }
    return { open_count: open, by_state, aging: buckets, overdue_count: overdue };
  }
}
