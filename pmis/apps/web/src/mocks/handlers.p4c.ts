// MSW handlers of work package P4c (contract 0.12.11, migration 0063): the HLC purchase requests of an HLC record (Q150), the Dismantle order picker
// (Q114), the one-time migration of the legacy HLC requests (Q139) and the GECOL order warnings (Q151). Synthetic data; the rules mirror the database.
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import { REGISTER_DEFS, recId, type MockRecord } from './registersData';
import { db, save, stepUpValid, viewer } from './db';
import { guard, problem, stepUp } from './handlers';
import { toRecord } from './handlers.registers';
import { dismantleOrders, gecolCfg } from './p4cData';
import { siteIndex, siteMeta } from './sites';

const B = API_BASE;
const R = () => db().reg;
const isAdmin = () => viewer()?.key === 'pm';
const fields = (...errors: { path: string; code: string }[]) => problem(422, 'validation_failed', 'Validation failed', { errors });
const body = async <T,>(r: Request) => ((await r.json().catch(() => ({}))) ?? {}) as T;
const ifMatch = (req: Request, v: number) => {
  const h = req.headers.get('If-Match');
  if (!h) return problem(428, 'precondition_required', 'If-Match is required');
  return Number(h.replace(/"/g, '')) === v ? null : problem(412, 'precondition_failed', 'Changed by someone else; reload');
};
const gecolDates = () => (REGISTER_DEFS.find((d) => d.register_key === 'gecol')?.fields ?? []).filter((f) => f.type === 'date');
const gecolJson = () => {
  const c = gecolCfg();
  return { enabled: c.enabled, chains: c.chains, billing_after: c.billing_after, version: c.version, updated_at: null, updated_by: null,
    fields: gecolDates().map((f) => ({ code: f.code, label_en: f.label_en, label_ar: f.label_ar ?? null })) };
};

export const p4cHandlers = [
  http.put(`${B}/registers/hlc/records/:id/purchase-requests`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const r = R().records.find((x) => x.id === params.id && x.register_key === 'hlc');
    if (!r) return problem(404, 'not_found', 'Record not found');
    const m = ifMatch(request, r.version); if (m) return m;
    if (r.state !== 'entry') return problem(409, 'invalid_transition', 'The purchase requests are named while the record is in entry.');
    if (!toRecord(r).allowed_actions?.includes('edit')) return problem(403, 'not_eligible_holder', 'You do not hold the entry level');
    const b = await body<{ procurement_entity_ids?: unknown }>(request);
    if (!Array.isArray(b.procurement_entity_ids) || b.procurement_entity_ids.length > 20) return fields({ path: '/procurement_entity_ids', code: 'invalid' });
    const ids = [...new Set(b.procurement_entity_ids as string[])];
    const bad = ids.map((e, i) => [e, i] as const).filter(([e]) => !R().records.some((x) => x.entity_id === e && x.register_key === 'procurement' && x.site_index === r.site_index && x.data.scope === 'HLC' && x.state !== 'voided'));
    if (bad.length) return fields(...bad.map(([, i]) => ({ path: `/procurement_entity_ids/${i}`, code: 'not_hlc_pr' })));
    r.pr_links = ids; r.version += 1; r.updated_at = new Date().toISOString(); save();
    return HttpResponse.json(toRecord(r), { headers: { ETag: `"${r.version}"` } });
  }),

  http.get(`${B}/registers/dismantle/order-options`, ({ request }) => {
    const g = guard(); if (g) return g;
    const u = new URL(request.url).searchParams;
    const site = u.get('site_id'), part = u.get('record_type') ?? '';
    const si = site ? siteIndex(site) : -1;
    if (!['cw', 'te'].includes(part)) return fields({ path: '/record_type', code: 'invalid' });
    if (si === null || si < 0) return problem(404, 'not_found', 'The site does not exist or is not visible to you.');
    const items = dismantleOrders(R().records, si, part).map((o: MockRecord) => ({
      entity_id: o.entity_id, record_id: o.id, scope: o.data.scope, delivery: o.data.delivery, pr_no: o.data.pr_no, po_wo_no: o.data.po_wo_no, po_wo_date: o.data.po_wo_date,
      order_status: o.data.order_status, external_party: o.external_party ?? null,
    }));
    return HttpResponse.json({ items });
  }),

  http.post(`${B}/registers/hlc/legacy-migration`, async ({ request }) => {
    const g = guard(); if (g) return g;
    if (!isAdmin()) return problem(403, 'action_forbidden', 'You need administer on procurement.');
    const b = await body<{ dry_run?: unknown; reason?: string }>(request);
    if (typeof b.dry_run !== 'boolean') return fields({ path: '/dry_run', code: 'required' });
    if (!b.dry_run && (b.reason ?? '').trim().length < 3) return fields({ path: '/reason', code: 'required' });
    if (!b.dry_run && !stepUpValid()) return stepUp();
    const legacy = R().records.filter((x) => x.register_key === 'hlc' && x.state !== 'voided' && (x.data.request_no || x.data.request_date));
    const counts = { create: 0, duplicate: 0, already_migrated: 0 };
    const moved = ((R() as { legacyMoved?: Record<string, string> }).legacyMoved ??= {});   // legacy HLC entity -> the Procurement record (hlc_legacy_migrations)
    const items = legacy.map((h) => {
      const m = siteMeta(h.site_index!), no = h.data.request_no as string | undefined;
      const mig = moved[h.entity_id];
      const dup = no ? R().records.find((p) => p.register_key === 'procurement' && p.site_index === h.site_index && p.data.scope === 'HLC' && String(p.data.pr_no ?? '').trim().toLowerCase() === no.trim().toLowerCase()) : undefined;
      const outcome: 'create' | 'duplicate' | 'already_migrated' = mig ? 'already_migrated' : dup ? 'duplicate' : 'create';
      let pid = mig ?? dup?.id;
      counts[outcome] += 1;
      if (!b.dry_run && outcome !== 'already_migrated') {
        if (outcome === 'create') {
          const id = recId(++R().seq), now = new Date().toISOString();
          R().records.unshift({ id, entity_id: id, version_no: 1, register_key: 'procurement', record_type: 'pr', site_index: h.site_index, state: 'entry', current_level: 1, levels_required: 2,
            data: { scope: 'HLC', ...(no ? { pr_no: no } : {}), ...(h.data.request_date ? { pr_date: h.data.request_date } : {}), remark: 'Migrated from the legacy HLC request of the HLC register (Q139): complete it and submit it.' },
            version: 1, return_count: 0, last_return_note: null, created_by: viewer()!.employee_id ?? '9999', created_at: now, updated_at: now, steps: [] });
          pid = id;
        }
        moved[h.entity_id] = pid!;
      }
      return { hlc_record_id: h.id, hlc_entity_id: h.entity_id, site_id: m.id, site_code: m.code, region_id: m.region_id, request_no: no, request_date: h.data.request_date as string | undefined, outcome, ...(pid ? { procurement_record_id: pid } : {}) };
    });
    save();
    return HttpResponse.json({ dry_run: b.dry_run, items, counts });
  }),

  http.get(`${B}/settings/gecol-order-warnings`, () => { const g = guard(); if (g) return g; const j = gecolJson(); return HttpResponse.json(j, { headers: { ETag: `"${j.version}"` } }); }),
  http.put(`${B}/settings/gecol-order-warnings`, async ({ request }) => {
    const g = guard(); if (g) return g;
    if (!isAdmin()) return problem(403, 'action_forbidden', 'Administrators only');
    const m = ifMatch(request, gecolCfg().version); if (m) return m;
    const b = await body<{ reason?: string; enabled?: unknown; chains?: unknown; billing_after?: unknown } & Record<string, unknown>>(request);
    const errs: { path: string; code: string }[] = [];
    for (const k of Object.keys(b)) if (!['reason', 'enabled', 'chains', 'billing_after'].includes(k)) errs.push({ path: `/${k}`, code: 'unknown_key' });
    if ((b.reason ?? '').trim().length < 3) errs.push({ path: '/reason', code: 'required' });
    if (typeof b.enabled !== 'boolean') errs.push({ path: '/enabled', code: 'required' });
    const dates = gecolDates().map((f) => f.code);
    if (!Array.isArray(b.chains) || b.chains.length > 10) errs.push({ path: '/chains', code: 'invalid' });
    else (b.chains as unknown[]).forEach((c, i) => {
      if (!Array.isArray(c) || c.length < 2 || c.length > 20) { errs.push({ path: `/chains/${i}`, code: 'invalid' }); return; }
      c.forEach((x, j) => { if (typeof x !== 'string' || !dates.includes(x)) errs.push({ path: `/chains/${i}/${j}`, code: 'unknown_field' }); else if (c.indexOf(x) !== j) errs.push({ path: `/chains/${i}/${j}`, code: 'duplicate' }); });
    });
    if (b.billing_after !== null && b.billing_after !== undefined && (typeof b.billing_after !== 'string' || !dates.includes(b.billing_after) || b.billing_after === 'billing_conversion_date')) errs.push({ path: '/billing_after', code: 'unknown_field' });
    if (errs.length) return fields(...errs);
    const c = gecolCfg();
    Object.assign(c, { enabled: b.enabled as boolean, chains: b.chains as string[][], billing_after: (b.billing_after as string | null) ?? null, version: c.version + 1 });
    save();
    const j = gecolJson();
    return HttpResponse.json(j, { headers: { ETag: `"${j.version}"` } });
  }),
];
