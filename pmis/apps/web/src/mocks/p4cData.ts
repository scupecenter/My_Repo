// Work package P4c (contract 0.12.11, migration 0063): what the mock computes like the database does. Pure functions over the mock records, shared by
// handlers.registers.ts (the record view) and handlers.p4c.ts (the new endpoints).
import type { HlcPurchaseRequests } from '@/api/p4c';
import { db } from './db';
import type { MockRecord } from './registersData';

type W = { path: string; code: string; message?: string; related_path?: string };

/** Q151 setting as the mock keeps it (seed of migration 0063: off, the draft order of the owner answer). */
export const GECOL_ORDER_SEED = {
  enabled: false,
  chains: [['request_date', 'survey_date', 'layout_received', 'layout_approved'], ['installation_finish', 'aat_acceptance_date', 'power_on_date']],
  billing_after: null as string | null,
  version: 1,
};
export type GecolOrderCfg = typeof GECOL_ORDER_SEED;
/** The mock store keeps the setting beside the other settings (a store saved before 0.12.11 starts from the seed). */
export const gecolCfg = (): GecolOrderCfg => ((db().cfg as { gecolOrder?: GecolOrderCfg }).gecolOrder ??= { ...GECOL_ORDER_SEED, chains: GECOL_ORDER_SEED.chains.map((c) => [...c]) });

export const cancelled = (r: MockRecord | undefined) => /^\s*cancel/i.test(String(r?.data.order_status ?? ''));
const versions = (all: MockRecord[], entity: string) => all.filter((x) => x.entity_id === entity).sort((a, b) => b.version_no - a.version_no);
const currentOf = (all: MockRecord[], entity: string) => versions(all, entity).find((x) => x.state === 'approved');

/** Q150: the required HLC requests of a site (named ones, or every submitted one), cancelled ones left out. */
export function hlcPrView(r: MockRecord, all: MockRecord[]): HlcPurchaseRequests {
  const ents = [...new Set(all.filter((x) => x.register_key === 'procurement' && x.site_index === r.site_index && x.state !== 'voided' && x.data.scope === 'HLC').map((x) => x.entity_id))];
  const links = r.pr_links ?? [];
  const latest = (e: string) => versions(all, e)[0]!;
  const submitted = (e: string) => versions(all, e).some((x) => x.state !== 'entry' || x.version_no > 1);
  const req = ents.filter((e) => !cancelled(currentOf(all, e)) && (links.length ? links.includes(e) : submitted(e)));
  const items = req.map((e) => {
    const c = currentOf(all, e), l = latest(e), d = (c ?? l).data as Record<string, string | undefined>;
    return { entity_id: e, record_id: (c ?? l).id, pr_no: d.pr_no, pr_date: d.pr_date, hlc_approval_date: c?.data.hlc_approval_date as string | undefined, approved: !!c, state: l.state };
  });
  const dated = items.filter((i) => i.approved && i.hlc_approval_date);
  const complete = items.length > 0 && dated.length === items.length;
  return {
    linked_explicitly: links.length > 0, complete, required: items.length, approved_by_hlc: dated.length,
    hlc_approval_date: complete ? dated.map((i) => i.hlc_approval_date!).sort().pop()! : null,
    items,
    candidates: ents.map((e) => { const l = latest(e); return { entity_id: e, record_id: l.id, pr_no: l.data.pr_no as string | undefined, pr_date: l.data.pr_date as string | undefined, state: l.state, cancelled: cancelled(currentOf(all, e)), linked: links.includes(e) }; }),
  };
}

/** The approved, active orders of a Dismantle part (Q114). */
export const dismantleOrders = (all: MockRecord[], site: number | null, part: string) => {
  const scope = part === 'cw' ? 'CW Dismantle' : part === 'te' ? 'TE Dismantle' : '';
  return all.filter((x) => x.register_key === 'procurement' && x.site_index === site && x.state === 'approved' && x.data.scope === scope && !cancelled(x)
    && currentOf(all, x.entity_id)?.id === x.id);
};

/** The reviewer warnings of 0063 the mock adds (Q150 HLC, Q151 GECOL, Q114 Dismantle). */
export function p4cWarnings(r: MockRecord, all: MockRecord[], gecol: GecolOrderCfg): W[] {
  const d = r.data as Record<string, string | boolean | undefined>, w: W[] = [];
  if (r.register_key === 'hlc') {
    const v = hlcPrView(r, all);
    if (v.required > 1 && !v.complete) w.push({ path: '/data/hlc_approval_date', code: 'hlc_prs_incomplete' });
    if (v.required > 1 && !v.linked_explicitly) w.push({ path: '/data/pr_no', code: 'hlc_prs_not_linked' });
    if (d.pr_exception === true && !v.complete) w.push({ path: '/data/pr_exception', code: 'pr_exception_used' });
  } else if (r.register_key === 'gecol' && gecol.enabled) {
    for (const chain of gecol.chains) {
      let prev: string | undefined, prevCode: string | undefined;
      for (const c of chain) {
        const x = typeof d[c] === 'string' ? (d[c] as string) : undefined;
        if (!x) continue;
        if (prev && x < prev) w.push({ path: `/data/${c}`, code: 'gecol_order', related_path: `/data/${prevCode}` });
        else { prev = x; prevCode = c; }
      }
    }
    const ev = gecol.billing_after, b = d.billing_conversion_date as string | undefined, e = ev ? (d[ev] as string | undefined) : undefined;
    if (ev && b && e && b < e) w.push({ path: '/data/billing_conversion_date', code: 'billing_before_event', related_path: `/data/${ev}` });
  } else if (r.register_key === 'dismantle') {
    if (!d.execution_mode) w.push({ path: '/data/execution_mode', code: 'execution_mode_missing' });
    else if (d.execution_mode === 'Outsourced' && r.state === 'entry' && !d.procurement_order_id) w.push({ path: '/data/procurement_order_id', code: 'order_not_chosen' });
  }
  return w;
}

/** Q114: the contractor of an outsourced part is the chosen order's (none while no order is chosen); in-house work has none. */
export function deriveDismantle(r: MockRecord, all: MockRecord[]) {
  if (r.register_key !== 'dismantle' || r.state !== 'entry') return;
  const mode = r.data.execution_mode;
  if (mode === 'In-House') { r.external_party = null; return; }
  if (mode !== 'Outsourced') return;
  const orders = dismantleOrders(all, r.site_index, r.record_type ?? '');
  if (!r.data.procurement_order_id && orders.length === 1) r.data.procurement_order_id = orders[0]!.entity_id;
  const o = orders.find((x) => x.entity_id === r.data.procurement_order_id);
  r.external_party = o?.external_party ?? null;
}
