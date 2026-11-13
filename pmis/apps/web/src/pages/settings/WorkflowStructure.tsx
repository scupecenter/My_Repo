import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { useMigrateSites, usePreviewMigration, useRevertMigration, useSiteMigrations, type GateCondition, type StructureInput, type WorkflowVersion, type WorkflowVersionSummary } from '@/api/workflowEditor';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { fieldErrors } from '@/lib/fields';

/** Decisions 2026-11-13 (maximum flexibility): the structure of a draft (milestones, gates, their conditions), the migration of open sites and its revert. */
type M = { code: string; name_en: string; name_ar: string; is_active: boolean; isNew?: boolean };
type G = { code: string; name_en: string; name_ar: string; from_milestone: string; to_milestone: string; is_active: boolean; sla_min_wd: string; sla_max_wd: string; conditions: GateCondition[]; isNew?: boolean };
const CONDITION_TYPES = ['milestone', 'task', 'permit', 'date_field', 'stop_work_blocks'];

export function useStructureErr() {
  const { t } = useTranslation();
  return (e: unknown) => {
    if (e instanceof ApiError) {
      if (e.code === 'stale_preview') return t('wfe.err.stale_preview');
      const first = Object.values(fieldErrors(e))[0];
      if (first && t(`wfe.err.${first}`) !== `wfe.err.${first}`) return t(`wfe.err.${first}`);
    }
    return errText(e, t);
  };
}

/** The conditions of a gate: type, reference (task code, milestone code...) and "N/A counts as done". */
export function ConditionsEditor({ value, onChange, prefix }: { value: GateCondition[]; onChange: (v: GateCondition[]) => void; prefix: string }) {
  const { t } = useTranslation();
  const set = (i: number, patch: Partial<GateCondition>) => onChange(value.map((c, k) => (k === i ? { ...c, ...patch } : c)));
  return (
    <div className="space-y-1" data-testid={`${prefix}-conditions`}>
      <p className="text-xs font-semibold">{t('wfe.conditions')}</p>
      {value.map((c, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1">
          <select className="input" aria-label={t('wfe.condition_type')} data-testid={`${prefix}-ctype-${i}`} value={c.type} onChange={(e) => set(i, { type: e.target.value })}>
            {CONDITION_TYPES.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
          <input className="input w-32" dir="ltr" aria-label={t('wfe.condition_ref')} data-testid={`${prefix}-cref-${i}`} value={c.ref ?? ''} onChange={(e) => set(i, { ref: e.target.value })} />
          <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={c.accept_na ?? false} onChange={(e) => set(i, { accept_na: e.target.checked })} />{t('wfe.accept_na')}</label>
          <button type="button" className="btn" aria-label={t('common.remove')} onClick={() => onChange(value.filter((_, k) => k !== i))}><Trash2 size={14} aria-hidden /></button>
        </div>
      ))}
      <button type="button" className="btn" data-testid={`${prefix}-add-condition`} onClick={() => onChange([...value, { type: 'task', ref: '' }])}><Plus size={14} aria-hidden /> {t('wfe.add_condition')}</button>
    </div>
  );
}

const swap = <T,>(a: T[], i: number, d: -1 | 1): T[] => { const n = [...a]; [n[i], n[i + d]] = [n[i + d]!, n[i]!]; return n; };

/** Add, rename, reorder and deactivate milestones and gates of a draft; the order of the lists is the order of the version. */
export function StructureDialog({ v, onClose, onSubmit, busy, error }: { v: WorkflowVersion; onClose: () => void; busy: boolean; error: string | null; onSubmit: (s: Omit<StructureInput, 'reason'>, reason: string) => void }) {
  const { t } = useTranslation();
  const [ms, setMs] = useState<M[]>((v.milestones as unknown as { code: string; name_en: string; name_ar?: string | null; is_active?: boolean }[]).map((m) => ({ code: m.code, name_en: m.name_en, name_ar: m.name_ar ?? '', is_active: m.is_active !== false })));
  const [gs, setGs] = useState<G[]>((v.gates as unknown as { code: string; name_en: string; name_ar?: string | null; from_milestone: string; to_milestone: string; is_active?: boolean; sla_min_wd?: number | null; sla_max_wd?: number | null; conditions?: GateCondition[] }[])
    .map((g) => ({ code: g.code, name_en: g.name_en, name_ar: g.name_ar ?? '', from_milestone: g.from_milestone, to_milestone: g.to_milestone, is_active: g.is_active !== false, sla_min_wd: String(g.sla_min_wd ?? 0), sla_max_wd: String(g.sla_max_wd ?? 0), conditions: g.conditions ?? [] })));
  const [mc, setMc] = useState('');
  const [mn, setMn] = useState('');
  const [gc, setGc] = useState('');
  const setM = (i: number, p: Partial<M>) => setMs(ms.map((m, k) => (k === i ? { ...m, ...p } : m)));
  const setG = (i: number, p: Partial<G>) => setGs(gs.map((g, k) => (k === i ? { ...g, ...p } : g)));
  const active = ms.filter((m) => m.is_active);
  return (
    <FormDialog open wide onClose={onClose} testid="wfe-structure-dialog" title={t('wfe.edit_structure')} busy={busy} error={error}
      onSubmit={(reason) => onSubmit({
        milestones: ms.map((m) => ({ code: m.code, name_en: m.name_en.trim(), name_ar: m.name_ar.trim() || null, is_active: m.is_active })),
        gates: gs.map((g) => ({ code: g.code, name_en: g.name_en.trim(), name_ar: g.name_ar.trim() || null, from_milestone: g.from_milestone, to_milestone: g.to_milestone, is_active: g.is_active, conditions: g.conditions.filter((c) => c.type === 'stop_work_blocks' || (c.ref ?? '').trim()), sla_min_wd: Number(g.sla_min_wd || 0), sla_max_wd: Number(g.sla_max_wd || 0) })),
      }, reason)}>
      <p className="text-sm text-mute">{t('wfe.structure_hint')}</p>
      <h5 className="font-semibold">{t('wfe.milestones')}</h5>
      <ol className="space-y-1" data-testid="wfe-st-milestones">
        {ms.map((m, i) => (
          <li key={m.code} className="flex flex-wrap items-center gap-1" data-testid={`wfe-st-ms-${m.code}`}>
            <span className="mono w-16">{m.code}</span>
            <input className="input w-44" dir="ltr" aria-label={t('wfe.name_en')} data-testid={`wfe-st-ms-en-${m.code}`} value={m.name_en} onChange={(e) => setM(i, { name_en: e.target.value })} />
            <input className="input w-44" dir="rtl" aria-label={t('wfe.name_ar')} value={m.name_ar} onChange={(e) => setM(i, { name_ar: e.target.value })} />
            <label className="flex items-center gap-1 text-xs"><input type="checkbox" data-testid={`wfe-st-ms-active-${m.code}`} checked={m.is_active} onChange={(e) => setM(i, { is_active: e.target.checked })} />{t('wfe.active')}</label>
            <button type="button" className="btn" aria-label={t('wfe.up')} disabled={i === 0} onClick={() => setMs(swap(ms, i, -1))}><ArrowUp size={14} aria-hidden /></button>
            <button type="button" className="btn" aria-label={t('wfe.down')} disabled={i === ms.length - 1} onClick={() => setMs(swap(ms, i, 1))}><ArrowDown size={14} aria-hidden /></button>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-end gap-1">
        <input className="input w-24" dir="ltr" placeholder={t('wfe.code')} aria-label={t('wfe.code')} data-testid="wfe-st-new-ms-code" value={mc} onChange={(e) => setMc(e.target.value)} />
        <input className="input w-48" dir="ltr" placeholder={t('wfe.name_en')} aria-label={t('wfe.name_en')} data-testid="wfe-st-new-ms-name" value={mn} onChange={(e) => setMn(e.target.value)} />
        <button type="button" className="btn" data-testid="wfe-st-add-ms" disabled={!mc.trim() || !mn.trim()} onClick={() => { setMs([...ms, { code: mc.trim().toUpperCase(), name_en: mn.trim(), name_ar: '', is_active: true, isNew: true }]); setMc(''); setMn(''); }}><Plus size={14} aria-hidden /> {t('wfe.add_milestone')}</button>
      </div>
      <h5 className="font-semibold">{t('wfe.gates')}</h5>
      <ol className="space-y-2" data-testid="wfe-st-gates">
        {gs.map((g, i) => (
          <li key={g.code} className="rounded border border-line p-2" data-testid={`wfe-st-gate-${g.code}`}>
            <div className="flex flex-wrap items-center gap-1">
              <span className="mono w-16">{g.code}</span>
              <input className="input w-44" dir="ltr" aria-label={t('wfe.name_en')} value={g.name_en} onChange={(e) => setG(i, { name_en: e.target.value })} />
              <select className="input" aria-label={t('wfe.gate_from')} data-testid={`wfe-st-gate-from-${g.code}`} value={g.from_milestone} onChange={(e) => setG(i, { from_milestone: e.target.value })}>{active.map((m) => <option key={m.code} value={m.code}>{m.code}</option>)}</select>
              <span aria-hidden>{'→'}</span>
              <select className="input" aria-label={t('wfe.gate_to')} data-testid={`wfe-st-gate-to-${g.code}`} value={g.to_milestone} onChange={(e) => setG(i, { to_milestone: e.target.value })}>{active.map((m) => <option key={m.code} value={m.code}>{m.code}</option>)}</select>
              <input type="number" min={0} className="input w-16" dir="ltr" aria-label="SLA min" value={g.sla_min_wd} onChange={(e) => setG(i, { sla_min_wd: e.target.value })} />
              <input type="number" min={0} className="input w-16" dir="ltr" aria-label="SLA max" value={g.sla_max_wd} onChange={(e) => setG(i, { sla_max_wd: e.target.value })} />
              <label className="flex items-center gap-1 text-xs"><input type="checkbox" data-testid={`wfe-st-gate-active-${g.code}`} checked={g.is_active} onChange={(e) => setG(i, { is_active: e.target.checked })} />{t('wfe.active')}</label>
              <button type="button" className="btn" aria-label={t('wfe.up')} disabled={i === 0} onClick={() => setGs(swap(gs, i, -1))}><ArrowUp size={14} aria-hidden /></button>
              <button type="button" className="btn" aria-label={t('wfe.down')} disabled={i === gs.length - 1} onClick={() => setGs(swap(gs, i, 1))}><ArrowDown size={14} aria-hidden /></button>
            </div>
            <ConditionsEditor value={g.conditions} onChange={(c) => setG(i, { conditions: c })} prefix={`wfe-st-gate-${g.code}`} />
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-end gap-1">
        <input className="input w-24" dir="ltr" placeholder={t('wfe.code')} aria-label={t('wfe.code')} data-testid="wfe-st-new-gate-code" value={gc} onChange={(e) => setGc(e.target.value)} />
        <button type="button" className="btn" data-testid="wfe-st-add-gate" disabled={!gc.trim() || active.length < 2}
          onClick={() => { setGs([...gs, { code: gc.trim().toUpperCase(), name_en: gc.trim().toUpperCase(), name_ar: '', from_milestone: active[0]!.code, to_milestone: active[1]!.code, is_active: true, sla_min_wd: '0', sla_max_wd: '0', conditions: [], isNew: true }]); setGc(''); }}>
          <Plus size={14} aria-hidden /> {t('wfe.add_gate')}</button>
      </div>
    </FormDialog>
  );
}

/** Migrate the open sites that are on another version to this published one: preview first (what stays, moves, is added or retired), then confirm. */
export function MigrationDialog({ version, versions, phrase, onClose }: { version: number; versions: WorkflowVersionSummary[]; phrase: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const err = useStructureErr();
  const [from, setFrom] = useState('');
  const [typed, setTyped] = useState('');
  const [master, setMaster] = useState('');
  const preview = usePreviewMigration(version);
  const migrate = useMigrateSites(version);
  const selection = from ? { filter: { from_version: Number(from) } } : { filter: {} };
  const pv = preview.data;
  const n = pv?.sites.length ?? 0;
  return (
    <FormDialog open wide onClose={onClose} testid="wfe-migrate-dialog" title={t('wfe.migrate_title', { version })} busy={migrate.isPending} error={migrate.isError ? err(migrate.error) : preview.isError ? err(preview.error) : null}
      disabled={!pv || n === 0 || typed !== `v${version}` || (!!phrase && master !== phrase)} submitLabel={t('wfe.migrate')}
      onSubmit={(reason) => migrate.mutate({ preview_hash: pv!.preview_hash, selection, reason, ...(phrase ? { confirm_master_impact: master } : {}) }, { onSuccess: (r) => { toast(t('wfe.migrated', { count: r.sites_migrated })); onClose(); } })}>
      <p className="text-sm text-mute">{t('wfe.migrate_hint')}</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm font-semibold">{t('wfe.from_version')}
          <select className="input mt-1 font-normal" data-testid="wfe-mig-from" value={from} onChange={(e) => { setFrom(e.target.value); preview.reset(); }}>
            <option value="">{t('wfe.any_version')}</option>
            {versions.filter((x) => x.version !== version && x.status === 'published').map((x) => <option key={x.version} value={x.version}>v{x.version}</option>)}
          </select></label>
        <button type="button" className="btn" data-testid="wfe-mig-preview" disabled={preview.isPending} onClick={() => preview.mutate(selection)}>{t('wfe.preview')}</button>
      </div>
      {pv && (n === 0 ? <p data-testid="wfe-mig-empty" className="text-sm text-mute">{t('wfe.migrate_none')}</p> : (
        <table className="w-full text-sm" data-testid="wfe-mig-table">
          <thead><tr className="text-mute"><th className="text-start">{t('wfe.site')}</th><th className="text-start">v</th><th className="text-start">{t('wfe.kept')}</th><th className="text-start">{t('wfe.moved')}</th><th className="text-start">{t('wfe.added')}</th><th className="text-start">{t('wfe.retired')}</th></tr></thead>
          <tbody>{pv.sites.map((s) => (
            <tr key={s.site_id} data-testid={`wfe-mig-site-${s.site_code}`}>
              <td className="mono">{s.site_code}</td><td>{s.from_version}</td><td>{s.tasks_kept?.length ?? 0}</td><td>{s.tasks_moved?.length ?? 0}</td><td>{s.tasks_added?.length ?? 0}</td><td>{s.tasks_retired?.length ?? 0}</td>
            </tr>))}</tbody>
        </table>
      ))}
      <label className="block text-sm font-semibold">{t('wfe.type_to_confirm', { text: `v${version}` })}<input className="input mt-1 font-normal" dir="ltr" data-testid="wfe-mig-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} /></label>
      {phrase && <label className="block text-sm font-semibold">{t('wfe.type_to_confirm', { text: phrase })}<input className="input mt-1 font-normal" dir="ltr" value={master} onChange={(e) => setMaster(e.target.value)} /></label>}
    </FormDialog>
  );
}

/** The log of site migrations with the revert of each one that still can be reverted. */
export function MigrationLog() {
  const { t } = useTranslation();
  const toast = useToast();
  const err = useStructureErr();
  const q = useSiteMigrations(true);
  const revert = useRevertMigration();
  const [target, setTarget] = useState<string | null>(null);
  const items = q.data?.items ?? [];
  if (q.isError || items.length === 0) return null;
  return (
    <section className="space-y-2 border-t border-line pt-3" data-testid="wfe-migrations">
      <h3 className="font-bold">{t('wfe.migration_log')}</h3>
      <table className="w-full text-sm">
        <thead><tr className="text-mute"><th className="text-start">{t('wfe.site')}</th><th className="text-start">{t('wfe.from_version')}</th><th className="text-start">{t('wfe.to_version')}</th><th className="text-start">{t('common.reason')}</th><th /></tr></thead>
        <tbody>{items.map((m) => (
          <tr key={m.id} data-testid={`wfe-migration-${m.id}`}>
            <td className="mono">{m.site_code}</td><td>v{m.from_version}</td><td>v{m.to_version}</td><td>{m.reason}</td>
            <td>{m.reverted_at ? t('wfe.reverted') : m.revertible && <button className="btn" data-testid={`wfe-revert-${m.id}`} onClick={() => { revert.reset(); setTarget(m.id); }}>{t('wfe.revert')}</button>}</td>
          </tr>))}</tbody>
      </table>
      {target && <FormDialog open onClose={() => setTarget(null)} testid="wfe-revert-dialog" title={t('wfe.revert')} busy={revert.isPending} error={revert.isError ? err(revert.error) : null}
        onSubmit={(reason) => revert.mutate({ id: target, reason }, { onSuccess: () => { toast(t('wfe.reverted')); setTarget(null); } })}>
        <p className="text-sm text-mute">{t('wfe.revert_hint')}</p>
      </FormDialog>}
    </section>
  );
}
