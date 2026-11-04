import { CheckCircle2, Clock, Eye } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDismantleOrders, useHlcLegacyMigration, useSetHlcPurchaseRequests, type HlcLegacyMigration } from '@/api/p4c';
import type { RegisterRecord } from '@/api/types';
import { registerErrorMessage } from '@/lib/registerErrors';
import { errText, FormDialog } from './FormDialog';
import { useToast } from './Toast';

/**
 * Work package P4c (contract 0.12.11, migration 0063). The pieces of the register screens that the owner answers of 2026-11-04 add:
 *   - Q150: the HLC purchase requests an HLC record covers, and whether all are approved by HLC (C3);
 *   - Q114: the Procurement order a Dismantle part takes its contractor (FO / FT) from;
 *   - Q139: the one-time migration of the legacy HLC requests into Procurement drafts (preview, then run).
 */

/** Q150: the required requests, their HLC approval, and (L1 in entry) the choice of the requests the record covers. */
export function HlcPurchaseRequests({ record }: { record: RegisterRecord }) {
  const { t } = useTranslation();
  const toast = useToast();
  const set = useSetHlcPurchaseRequests();
  const pr = record.purchase_requests;
  const linkedNow = pr?.candidates.filter((c) => c.linked).map((c) => c.entity_id) ?? [];
  const [picked, setPicked] = useState<string[] | null>(null);
  if (!pr) return null;
  const editable = record.state === 'entry' && !!record.allowed_actions?.includes('edit');
  const cur = picked ?? linkedNow;
  const changed = picked !== null && (picked.length !== linkedNow.length || picked.some((x) => !linkedNow.includes(x)));
  const flip = (id: string) => setPicked(cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  return (
    <section className="rounded-md border border-line p-3 text-sm" data-testid="reg-hlc-prs" aria-label={t('p4c.prs_title')}>
      <div className="mb-1 flex flex-wrap items-center gap-2 font-semibold">
        {t('p4c.prs_title')}
        {pr.complete
          ? <span className="chip bg-doneBg text-doneInk" data-testid="reg-hlc-prs-status" data-complete="true"><CheckCircle2 size={12} />{t('p4c.prs_complete', { date: pr.hlc_approval_date ?? '' })}</span>
          : <span className="chip bg-waitBg text-waitInk" data-testid="reg-hlc-prs-status" data-complete="false"><Clock size={12} />{t('p4c.prs_incomplete', { n: pr.approved_by_hlc, total: pr.required })}</span>}
      </div>
      <p className="text-mute" data-testid="reg-hlc-prs-mode">{pr.linked_explicitly ? t('p4c.prs_linked') : t('p4c.prs_all_submitted')}</p>
      {pr.items.length > 0 && (
        <ul className="mt-1 list-disc ps-5" data-testid="reg-hlc-prs-items">
          {pr.items.map((i) => (
            <li key={i.entity_id} data-testid={`reg-hlc-prs-item-${i.entity_id}`}>
              <span className="mono">{i.pr_no ?? '—'}</span>{' · '}
              {i.approved && i.hlc_approval_date ? t('registers.hlc_pr_approved', { date: i.hlc_approval_date }) : i.approved ? t('registers.hlc_pr_not_approved') : t(`regState.${i.state ?? 'entry'}`)}
            </li>
          ))}
        </ul>
      )}
      {editable && pr.candidates.length > 0 && (
        <fieldset className="mt-2 space-y-1" data-testid="reg-hlc-prs-picker">
          <legend className="text-mute">{t('p4c.prs_pick')}</legend>
          {pr.candidates.map((c) => (
            <label key={c.entity_id} className="flex items-center gap-2">
              <input type="checkbox" data-testid={`reg-hlc-prs-pick-${c.entity_id}`} checked={cur.includes(c.entity_id)} onChange={() => flip(c.entity_id)} />
              <span className="mono">{c.pr_no ?? '—'}</span>
              <span className="text-mute">{c.pr_date ?? ''}</span>
              {c.cancelled && <span className="chip bg-lateBg text-lateInk">{t('p4c.cancelled')}</span>}
            </label>
          ))}
          <button type="button" className="btn" data-testid="reg-hlc-prs-save" disabled={!changed || set.isPending}
            onClick={() => set.mutate({ record, ids: cur }, { onSuccess: () => { setPicked(null); toast(t('registers.saved')); }, onError: (e) => toast(registerErrorMessage(t, e), 'err') })}>
            {t('p4c.prs_save')}
          </button>
        </fieldset>
      )}
    </section>
  );
}

/** Q114: the Procurement order of an outsourced Dismantle part; the contractor shown is the order's. */
export function DismantleOrderSelect({ siteId, part, value, onChange, editable, invalid }: {
  siteId: string | null | undefined; part: string | null | undefined; value: unknown; onChange: (v: string | null) => void; editable: boolean; invalid?: boolean;
}) {
  const { t } = useTranslation();
  const q = useDismantleOrders(siteId, part);
  const items = q.data ?? [];
  const cur = typeof value === 'string' ? value : '';
  const chosen = items.find((i) => i.entity_id === cur);
  const label = (i: (typeof items)[number]) => `${i.po_wo_no ?? i.pr_no ?? i.entity_id.slice(0, 8)} · ${i.external_party?.name ?? t('p4c.no_contractor')}`;
  return (
    <div data-testid="reg-dismantle-order">
      {editable
        ? (
          <select id="reg-field-procurement_order_id" data-testid="reg-field-procurement_order_id" className="input" aria-invalid={invalid || undefined} value={cur}
            onChange={(e) => onChange(e.target.value || null)} disabled={!siteId || !part}>
            <option value="">{!siteId || !part ? t('p4c.order_site_first') : items.length ? t('registers.choose') : t('p4c.no_orders')}</option>
            {items.map((i) => <option key={i.entity_id} value={i.entity_id}>{label(i)}</option>)}
            {cur && !chosen && <option value={cur}>{cur.slice(0, 8)}</option>}
          </select>
        )
        : <div className="font-semibold" data-testid="reg-view-procurement_order_id">{chosen ? label(chosen) : cur ? cur.slice(0, 8) : '—'}</div>}
      {chosen && <p className="text-sm text-mute" data-testid="reg-dismantle-contractor">{t('p4c.contractor_from_order', { name: chosen.external_party?.name ?? t('p4c.no_contractor') })}</p>}
      {editable && items.length > 1 && !cur && <p className="text-sm text-waitInk" data-testid="reg-dismantle-choose">{t('p4c.order_choose', { count: items.length })}</p>}
    </div>
  );
}

/** Q139: preview, then run with a reason (the server asks for a step-up). */
export function HlcLegacyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const run = useHlcLegacyMigration();
  const [preview, setPreview] = useState<HlcLegacyMigration | null>(null);
  const shown = run.data ?? preview;
  return (
    <FormDialog open={open} onClose={() => { setPreview(null); run.reset(); onClose(); }} testid="hlc-legacy" wide title={t('p4c.legacy_title')} submitLabel={t('p4c.legacy_run')}
      busy={run.isPending} disabled={!preview} error={run.isError ? errText(run.error, t) : null}
      onSubmit={(reason) => run.mutate({ dry_run: false, reason }, { onSuccess: (r) => toast(t('p4c.legacy_done', { count: r.counts.create })) })}>
      <p className="text-sm text-mute">{t('p4c.legacy_note')}</p>
      <button type="button" className="btn" data-testid="hlc-legacy-preview" disabled={run.isPending}
        onClick={() => run.mutate({ dry_run: true }, { onSuccess: (r) => { setPreview(r); } })}><Eye size={14} />{t('p4c.legacy_preview')}</button>
      {shown && (
        <div data-testid="hlc-legacy-result" data-dry-run={shown.dry_run ? 'true' : 'false'}>
          <p className="text-sm" data-testid="hlc-legacy-counts">{t('p4c.legacy_counts', { create: shown.counts.create, duplicate: shown.counts.duplicate, done: shown.counts.already_migrated })}</p>
          <ul className="max-h-60 overflow-y-auto text-sm">
            {shown.items.map((i) => (
              <li key={i.hlc_record_id} data-testid={`hlc-legacy-item-${i.hlc_record_id}`} data-outcome={i.outcome}>
                <span className="mono">{i.site_code ?? '—'}</span> · {i.request_no ?? '—'} · {i.request_date ?? '—'} · {t(`p4c.outcome_${i.outcome}`)}
                {i.date_dropped && <span className="chip ms-1 bg-waitBg text-waitInk">{t('p4c.date_dropped')}</span>}
              </li>
            ))}
            {!shown.items.length && <li className="text-mute">{t('p4c.legacy_none')}</li>}
          </ul>
        </div>
      )}
    </FormDialog>
  );
}
