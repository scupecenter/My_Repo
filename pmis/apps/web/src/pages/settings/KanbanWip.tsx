import { useState } from 'react';
import { UnsavedGuard } from '@/lib/unsavedGuard';
import { useTranslation } from 'react-i18next';
import { useKanbanWip, useSetKanbanWip } from '@/api/boards';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { QueryFallback } from '@/components/States';

const MIN = 1;
const MAX = 10000;

/**
 * Settings, Workflow, Board (F5, contract 0.15.32, migration 0118): the WIP limit of each milestone column of the Site Master board. No limit by
 * default. A limit is a warning on the board only: a column above it is marked, nothing is ever blocked or moved. Every signed-in user sees the
 * values; a System Admin or a delegate of settings edit for all regions changes them, with a reason (audited).
 */
export function KanbanWip() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useKanbanWip(), set = useSetKanbanWip();
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [open, setOpen] = useState(false);
  if (!q.data) return <QueryFallback queries={[q]} testid="wip-loading" />;
  const cur = q.data;
  const values: Record<string, string> = draft ?? Object.fromEntries(cur.columns.map((c) => [c.code, cur.limits[c.code] ? String(cur.limits[c.code]) : '']));
  const bad = (v: string) => v.trim() !== '' && (!/^[0-9]+$/.test(v.trim()) || Number(v) < MIN || Number(v) > MAX);
  const invalid = Object.values(values).some(bad);
  const next: Record<string, number | null> = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim() ? Number(v) : null]));
  const dirty = draft !== null && !invalid && cur.columns.some((c) => (cur.limits[c.code] ?? null) !== next[c.code]);
  const when = cur.updated_at ? new Date(cur.updated_at).toLocaleString(i18n.language === 'ar' ? 'ar-LY-u-nu-latn' : 'en-GB') : null;
  const name = (c: (typeof cur.columns)[number]) => (i18n.language === 'ar' && c.name_ar) || t(`stage.${c.code}`, { defaultValue: c.name_en });
  return (
    <section className="card space-y-3 p-4" data-testid="page-kanban-wip">
      <h2 className="font-bold">{t('board.wip_title')}</h2>
      <p className="text-sm text-mute">{t('board.wip_note')}</p>
      <table className="text-sm">
        <thead><tr><th className="pe-4 text-start">{t('board.wip_column')}</th><th className="text-start">{t('board.wip_limit_label')}</th></tr></thead>
        <tbody>
          {cur.columns.map((c) => (
            <tr key={c.code}>
              <td className="pe-4 py-1"><label htmlFor={`wip-${c.code}`}>{name(c)}</label> <span className="mono text-xs text-mute" dir="ltr">{c.code}</span></td>
              <td className="py-1">
                <input id={`wip-${c.code}`} className="input w-28" type="number" inputMode="numeric" min={MIN} max={MAX} step={1} dir="ltr" data-testid={`wip-${c.code}`}
                  placeholder={t('board.wip_none')} value={values[c.code] ?? ''} disabled={!cur.can_edit} aria-invalid={bad(values[c.code] ?? '')}
                  onChange={(e) => setDraft({ ...values, [c.code]: e.target.value })} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {invalid && <p role="alert" className="text-sm text-lateInk" data-testid="wip-error">{t('board.wip_range', { min: MIN, max: MAX })}</p>}
      <p className="text-xs text-mute" data-testid="wip-updated">
        {cur.updated_by && when ? t('importsSettings.updated', { name: cur.updated_by.display_name, id: cur.updated_by.employee_id ?? '', when }) : t('importsSettings.never')}
      </p>
      {cur.can_edit
        ? <button className="btn btn-accent" data-testid="wip-save" disabled={!dirty} onClick={() => setOpen(true)}>{t('common.save')}</button>
        : <p className="text-sm text-mute" data-testid="wip-readonly">{t('importsSettings.readonly')}</p>}
      <UnsavedGuard scope="settings" dirty={dirty} needsReason label={t('ui.guard_settings')} onSave={(reason) => new Promise<boolean>((res) => set.mutate({ version: cur.version, limits: next, reason }, { onSuccess: () => res(true), onError: () => res(false) }))} />
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="wip-dialog" title={t('board.wip_title')} busy={set.isPending} error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) => set.mutate({ version: cur.version, limits: next, reason }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setDraft(null); } })}>
          <p className="text-sm text-mute">{t('board.wip_confirm')}</p>
        </FormDialog>
      )}
    </section>
  );
}
