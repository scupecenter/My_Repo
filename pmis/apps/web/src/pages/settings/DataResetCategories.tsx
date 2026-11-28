import * as Dialog from '@radix-ui/react-dialog';
import { CheckCircle2, Lock } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DataResetPart, DataResetRequest } from '@/api/dataReset';

/**
 * The reset categories (owner request relayed 2026-11-28): a friendly layer over the EXISTING reset parts (no new part, no migration, the server still
 * decides and computes the closure). Each category is a list of part codes of data_reset_parts(); a code the server does not offer is ignored.
 * The Audit log is never a choice: it and the security log are a tamper-evident hash chain that the reset keeps by design (it fails if they change).
 * Users, roles, positions, permissions and settings are never part of these categories.
 */
export type CategoryId = 'daily_status' | 'media_documents' | 'invoices_payments' | 'alerts_notifications';
export const CATEGORIES: { id: CategoryId; parts: string[] }[] = [
  { id: 'daily_status', parts: ['daily_plan', 'kpi'] },
  { id: 'media_documents', parts: ['documents'] },
  { id: 'invoices_payments', parts: ['invoices'] },
  { id: 'alerts_notifications', parts: ['notifications'] },
];
/** The registers dropdown offers every part of the registers group, and Site Master (the `sites` part). */
export const registerParts = (catalogue: readonly DataResetPart[]) => catalogue.filter((p) => (p.group === 'registers' && p.code !== 'invoices') || p.code === 'sites');
const REGISTER_CODES_NOT = new Set(['invoices']);
const inCategory = (c: { parts: string[] }, catalogue: readonly DataResetPart[]) => c.parts.filter((x) => catalogue.some((p) => p.code === x));
const partLabel = (p: Pick<DataResetPart, 'label_en' | 'label_ar'> | undefined, code: string, lang: string) => (p ? (lang === 'ar' ? p.label_ar : p.label_en) : code);

/** The category checkboxes and the registers dropdown; they edit the same `chosen` list as the part grid (which stays under "by part"). */
export function CategoryPicker({ catalogue, chosen, setChosen }: { catalogue: DataResetPart[]; chosen: string[]; setChosen: (c: string[]) => void }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const regs = registerParts(catalogue);
  const toggleMany = (codes: string[], on: boolean) => setChosen(on ? [...new Set([...chosen, ...codes])] : chosen.filter((c) => !codes.includes(c)));
  const regsChosen = regs.filter((p) => chosen.includes(p.code));
  return (
    <div className="space-y-2 rounded-md bg-card2 p-3" data-testid="dr-cats">
      <h4 className="text-sm font-semibold">{t('dr.cats_title')}</h4>
      <details className="rounded-md border border-line bg-card p-2" data-testid="dr-cat-registers">
        <summary className="cursor-pointer text-sm font-semibold" data-testid="dr-cat-registers-summary">
          {t('dr.cat_registers')}{regsChosen.length > 0 ? ` (${t('dr.cat_registers_n', { count: regsChosen.length })})` : ''}
        </summary>
        <p className="mt-1 text-xs text-mute">{t('dr.cat_registers_hint')}</p>
        <div className="mt-1 grid gap-1 md:grid-cols-2">
          {regs.map((p) => (
            <label key={p.code} className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" data-testid={`dr-cat-reg-${p.code}`} checked={chosen.includes(p.code)} onChange={(e) => toggleMany([p.code], e.target.checked)} />
              <span>{partLabel(p, p.code, lang)}</span>
            </label>
          ))}
        </div>
      </details>
      {CATEGORIES.map((c) => {
        const codes = inCategory(c, catalogue);
        if (codes.length === 0) return null;
        const on = codes.every((x) => chosen.includes(x));
        return (
          <label key={c.id} className="flex items-start gap-2 text-sm" data-testid={`dr-cat-row-${c.id}`}>
            <input type="checkbox" className="mt-1" data-testid={`dr-cat-${c.id}`} checked={on} onChange={(e) => toggleMany(codes, e.target.checked)} />
            <span><span className="font-semibold">{t(`dr.cat_${c.id}`)}</span><span className="block text-xs text-mute">{t(`dr.cat_${c.id}_hint`)}</span></span>
          </label>
        );
      })}
      <div className="flex items-start gap-2 rounded-md border border-lateInk/40 bg-lateBg p-2 text-sm text-lateInk" data-testid="dr-cat-audit" role="note">
        <Lock size={16} className="mt-0.5 shrink-0" aria-hidden />
        <span><span className="font-semibold">{t('dr.cat_audit')}</span><span className="block text-xs">{t('dr.cat_audit_locked')}</span></span>
      </div>
    </div>
  );
}

type PartRows = { code: string; rows: number }[];
/** Rows per category of a scope: the part rows of the dry run (or of the request) summed over the category's parts that are in scope. */
export function categoryRows(parts: PartRows, scopeParts: readonly string[], catalogue: readonly DataResetPart[]): { key: string; label: string; rows: number; codes: string[] }[] {
  const rows = new Map(parts.map((p) => [p.code, p.rows]));
  const inScope = new Set(scopeParts);
  const used = new Set<string>();
  const out: { key: string; label: string; rows: number; codes: string[] }[] = [];
  const regs = registerParts(catalogue).filter((p) => inScope.has(p.code));
  if (regs.length > 0) { regs.forEach((p) => used.add(p.code)); out.push({ key: 'registers', label: 'registers', rows: regs.reduce((n, p) => n + (rows.get(p.code) ?? 0), 0), codes: regs.map((p) => p.code) }); }
  for (const c of CATEGORIES) {
    const codes = c.parts.filter((x) => inScope.has(x));
    if (codes.length === 0) continue;
    codes.forEach((x) => used.add(x));
    out.push({ key: c.id, label: c.id, rows: codes.reduce((n, x) => n + (rows.get(x) ?? 0), 0), codes });
  }
  const rest = [...inScope].filter((x) => !used.has(x) && !REGISTER_CODES_NOT.has(x));
  if (rest.length > 0) out.push({ key: 'other', label: 'other', rows: rest.reduce((n, x) => n + (rows.get(x) ?? 0), 0), codes: rest });
  return out;
}

function CatList({ rows, catalogue }: { rows: ReturnType<typeof categoryRows>; catalogue: readonly DataResetPart[] }) {
  const { t, i18n } = useTranslation();
  const names = (codes: string[]) => codes.map((c) => partLabel(catalogue.find((p) => p.code === c), c, i18n.language)).join(', ');
  return (
    <ul className="space-y-1 text-sm" data-testid="dr-cat-counts">
      {rows.map((r) => (
        <li key={r.key} className="rounded-md border border-line p-2" data-testid={`dr-cat-count-${r.key}`} data-rows={r.rows}>
          <span className="font-semibold">{r.key === 'registers' ? t('dr.cat_registers') : r.key === 'other' ? t('dr.cat_other') : t(`dr.cat_${r.key}`)}</span>
          <span className="ms-2 tabular-nums" dir="ltr">{t('dr.rows', { count: r.rows })}</span>
          <span className="block text-xs text-mute">{names(r.codes)}</span>
        </li>
      ))}
    </ul>
  );
}

/** The confirmation screen before the request is made: rows per category, the permanent warning, and what is never touched. The typed phrase stays on the form. */
export function ConfirmDialog({ rows, catalogue, everything, onClose, onConfirm, busy, error }: {
  rows: ReturnType<typeof categoryRows>; catalogue: readonly DataResetPart[]; everything: boolean; onClose: () => void; onConfirm: () => void; busy: boolean; error: string | null;
}) {
  const { t } = useTranslation();
  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="motion-overlay fixed inset-0 z-[70] bg-scrim/60" />
        <Dialog.Content data-testid="dr-confirm" className="motion-panel card fixed inset-x-0 top-[6vh] z-[70] mx-auto max-h-[88vh] w-[min(560px,94vw)] space-y-3 overflow-y-auto p-5">
          <Dialog.Title className="text-lg font-bold">{t('dr.confirm_title')}</Dialog.Title>
          <Dialog.Description className="sr-only">{t('dr.confirm_title')}</Dialog.Description>
          <p role="alert" className="rounded-md border border-lateInk bg-lateBg p-2 text-sm font-semibold text-lateInk" data-testid="dr-confirm-permanent">{t('dr.confirm_permanent')}</p>
          {everything && <p className="text-sm font-semibold" data-testid="dr-confirm-everything">{t('dr.confirm_everything')}</p>}
          <CatList rows={rows} catalogue={catalogue} />
          <p className="text-sm text-mute" data-testid="dr-confirm-kept">{t('dr.confirm_kept')}</p>
          {error && <p role="alert" className="text-sm text-lateInk" data-testid="dr-confirm-error">{error}</p>}
          <div className="flex justify-end gap-2">
            <button className="btn" data-testid="dr-confirm-back" disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
            <button className="btn btn-danger" data-testid="dr-confirm-go" disabled={busy} onClick={onConfirm}>{t('dr.confirm_go')}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const SEEN = 'dr-result-seen';
export const resultSeen = (id: string): boolean => { try { return localStorage.getItem(SEEN) === id; } catch { return false; } };
const markSeen = (id: string) => { try { localStorage.setItem(SEEN, id); } catch { /* the dialog still closes */ } };

/** The result: a centered dialog with a big check and the deleted counts; it stays until Close is pressed (no timer). */
export function ResultDialog({ r, catalogue, onClose }: { r: DataResetRequest; catalogue: readonly DataResetPart[]; onClose: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const deleted = ((r.result ?? {}) as { deleted?: Record<string, number> }).deleted ?? {};
  const total = Object.values(deleted).reduce((n, x) => n + x, 0);
  const atReq = ((r.plan_at_request ?? {}) as { parts?: Record<string, number> }).parts ?? {};
  const parts: PartRows = Object.entries(atReq).map(([code, rows]) => ({ code, rows }));
  const rows = categoryRows(parts, r.scope?.parts ?? Object.keys(atReq), catalogue);
  const close = () => { markSeen(r.id); setOpen(false); onClose(); };
  return (
    <Dialog.Root open={open} onOpenChange={() => { /* closed only by the Close button */ }}>
      <Dialog.Portal>
        <Dialog.Overlay className="motion-overlay fixed inset-0 z-[80] bg-scrim/60" />
        <Dialog.Content data-testid="dr-result-dialog" onEscapeKeyDown={(e) => e.preventDefault()} onPointerDownOutside={(e) => e.preventDefault()} onInteractOutside={(e) => e.preventDefault()}
          className="motion-panel card fixed left-1/2 top-1/2 z-[80] max-h-[88vh] w-[min(520px,94vw)] -translate-x-1/2 -translate-y-1/2 space-y-3 overflow-y-auto p-6 text-center">
          <CheckCircle2 size={72} className="mx-auto text-doneInk" aria-hidden data-testid="dr-result-check" />
          <Dialog.Title className="text-xl font-bold">{t('dr.result_done_title')}</Dialog.Title>
          <Dialog.Description className="text-sm text-mute" data-testid="dr-result-total">{t('dr.result_done_total', { count: total })}</Dialog.Description>
          <div className="text-start"><CatList rows={rows} catalogue={catalogue} /></div>
          <p className="text-sm text-mute">{t('dr.result_done_kept')}</p>
          <button className="btn btn-accent" data-testid="dr-result-close" onClick={close}>{t('common.close')}</button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
