import { Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useExpiryRadar, useSaveExpiryRadar, type ExpiryRadarInput } from '@/api/expiryRadar';
import { errText, FormDialog } from '@/components/FormDialog';
import { Tip } from '@/components/Tip';
import { useToast } from '@/components/Toast';
import { fieldErrors } from '@/lib/fields';
import { FieldErr } from './Calendar';

type Row = ExpiryRadarInput['registers'][number];
const MAX_LEADS = 6;

/**
 * Settings > Alerts > Expiry radar (migration 0760). The radar (0360) warns the Matrix holders of a register, in the bell, when a date that ends something (permit valid to, lease expiry,
 * equipment due date) is close. This screen edits the one setting it reads: the switch and, for each register, which date field counts and how many days before to warn (up to 6 times).
 * Saved with a reason, If-Match and an audit row. The recipients and whether the notice is also mailed stay where they are (Matrix, Mail kinds).
 */
export function ExpiryRadar() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useExpiryRadar(), save = useSaveExpiryRadar();
  const [f, setF] = useState<{ enabled: boolean; rows: Row[] } | null>(null);
  const [draft, setDraft] = useState<Record<number, string>>({});
  const [open, setOpen] = useState(false);
  const errs = fieldErrors(save.error);
  if (q.isError) return <p role="alert" className="card p-4 text-lateInk" data-testid="radar-error">{errText(q.error, t)}</p>;
  if (!q.data) return <p className="text-mute">{t('common.loading')}</p>;
  const cands = q.data.candidates;
  const ar = i18n.language === 'ar';
  const v = f ?? { enabled: q.data.enabled, rows: q.data.registers.map((r) => ({ register_key: r.register_key, field: r.field, lead_days: [...r.lead_days] })) };
  const regName = (k: string) => { const c = cands.find((x) => x.register_key === k) ?? q.data.registers.find((x) => x.register_key === k); return (ar && c?.name_ar) || c?.name_en || k; };
  const fieldsOf = (k: string) => cands.find((c) => c.register_key === k)?.fields ?? [];
  const fieldName = (k: string, code: string) => { const x = fieldsOf(k).find((y) => y.code === code); return (ar && x?.label_ar) || x?.label_en || code; };
  const setRow = (i: number, patch: Partial<Row>) => setF({ ...v, rows: v.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const free = cands.filter((c) => !v.rows.some((r) => r.register_key === c.register_key));
  const addRow = (k: string) => { const c = cands.find((x) => x.register_key === k); if (c) setF({ ...v, rows: [...v.rows, { register_key: k, field: c.fields[0]!.code, lead_days: [30, 14, 7] }] }); };
  const addLead = (i: number) => {
    const n = Number(draft[i]);
    const r = v.rows[i]!;
    if (!Number.isInteger(n) || n < 1 || n > 365 || r.lead_days.includes(n) || r.lead_days.length >= MAX_LEADS) return;
    setRow(i, { lead_days: [...r.lead_days, n].sort((a, b) => a - b) });
    setDraft({ ...draft, [i]: '' });
  };
  const dirty = f !== null;
  const invalid = v.rows.some((r) => r.lead_days.length < 1 || !r.field);
  return (
    <div className="space-y-4" data-testid="page-expiry-radar">
      <section className="card space-y-3 p-4">
        <div>
          <h2 className="font-bold">{t('radar.title')}</h2>
          <p className="text-sm text-mute">{t('radar.note')}</p>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="radar-enabled" checked={v.enabled} onChange={(e) => setF({ ...v, enabled: e.target.checked })} />{t('radar.enabled')}</label>
        <FieldErr errs={errs} path="/enabled" />
        {v.rows.length === 0 && <p className="text-sm text-mute" data-testid="radar-empty">{t('radar.empty')}</p>}
        <ul className="space-y-3">
          {v.rows.map((r, i) => (
            <li key={r.register_key} className="space-y-2 rounded-md border border-line p-3" data-testid={`radar-row-${r.register_key}`}>
              <div className="flex flex-wrap items-center gap-3">
                <b className="min-w-40"><bdi>{regName(r.register_key)}</bdi></b>
                <label className="flex items-center gap-2 text-sm">{t('radar.field')}
                  <select className="input" data-testid={`radar-field-${r.register_key}`} value={r.field} onChange={(e) => setRow(i, { field: e.target.value })}>
                    {!fieldsOf(r.register_key).some((x) => x.code === r.field) && <option value={r.field}>{r.field}</option>}
                    {fieldsOf(r.register_key).map((x) => <option key={x.code} value={x.code}>{(ar && x.label_ar) || x.label_en}</option>)}
                  </select>
                </label>
                <span className="flex-1" />
                <Tip text={t('radar.remove_hint', { name: regName(r.register_key) })}>
                  <button type="button" className="btn px-2" aria-label={t('radar.remove_hint', { name: regName(r.register_key) })} data-testid={`radar-remove-${r.register_key}`}
                    onClick={() => setF({ ...v, rows: v.rows.filter((_, j) => j !== i) })}><Trash2 size={16} /></button>
                </Tip>
              </div>
              <FieldErr errs={errs} path={`/registers/${i}/field`} />
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">{t('radar.lead')}</span>
                {r.lead_days.map((d) => (
                  <span key={d} className="chip bg-card2 gap-1" data-testid={`radar-lead-${r.register_key}-${d}`}>
                    {t('radar.days', { count: d })}
                    <Tip text={t('radar.lead_remove_hint', { days: d })}>
                      <button type="button" className="inline-flex" aria-label={t('radar.lead_remove_hint', { days: d })} onClick={() => setRow(i, { lead_days: r.lead_days.filter((x) => x !== d) })}><X size={12} /></button>
                    </Tip>
                  </span>
                ))}
                {r.lead_days.length < MAX_LEADS && (
                  <span className="inline-flex items-center gap-1">
                    <input type="number" min={1} max={365} className="input w-20" aria-label={t('radar.lead_add_label')} data-testid={`radar-lead-input-${r.register_key}`} value={draft[i] ?? ''}
                      onChange={(e) => setDraft({ ...draft, [i]: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addLead(i); } }} />
                    <Tip text={t('radar.lead_add_hint')}>
                      <button type="button" className="btn px-2" aria-label={t('radar.lead_add_hint')} data-testid={`radar-lead-add-${r.register_key}`} onClick={() => addLead(i)}><Plus size={14} /></button>
                    </Tip>
                  </span>
                )}
              </div>
              <FieldErr errs={errs} path={`/registers/${i}/lead_days`} />
              <FieldErr errs={errs} path={`/registers/${i}/register_key`} />
              {r.lead_days.length > 0 && <p className="text-xs text-mute" data-testid={`radar-preview-${r.register_key}`}>{t('radar.preview', { days: r.lead_days.join(', '), field: fieldName(r.register_key, r.field) })}</p>}
            </li>
          ))}
        </ul>
        {free.length > 0 && (
          <label className="flex items-center gap-2 text-sm">{t('radar.add')}
            <select className="input" data-testid="radar-add" value="" onChange={(e) => { if (e.target.value) addRow(e.target.value); }}>
              <option value="">{t('radar.add_pick')}</option>
              {free.map((c) => <option key={c.register_key} value={c.register_key}>{(ar && c.name_ar) || c.name_en}</option>)}
            </select>
          </label>
        )}
        <FieldErr errs={errs} path="/registers" />
        <div className="flex gap-2">
          <button className="btn btn-accent" data-testid="radar-save" disabled={!dirty || invalid} onClick={() => setOpen(true)}>{t('common.save')}</button>
          {dirty && <button className="btn" data-testid="radar-reset" onClick={() => { setF(null); setDraft({}); }}>{t('radar.undo')}</button>}
        </div>
      </section>
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="radar-dialog" title={t('radar.title')} busy={save.isPending} error={save.isError && !Object.keys(errs).length ? errText(save.error, t) : null}
          onSubmit={(reason) => save.mutate({ version: q.data.version, enabled: v.enabled, registers: v.rows, reason }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setF(null); setDraft({}); } })} />
      )}
    </div>
  );
}
