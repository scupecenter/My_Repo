import { Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMe } from '@/api/hooks';
import { useRegions } from '@/api/sites';
import type { StatusHealth, StatusUpdate } from '@/api/types';
import { useStatusOps, useStatusUpdates, type StatusFilter } from '@/api/x';
import { errText, FormDialog } from '@/components/FormDialog';
import { PageHeader, Toolbar } from '@/components/PageHeader';
import { PersonTag } from '@/components/PersonTag';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/States';
import { useToast } from '@/components/Toast';
import { canReassign } from '@/lib/x';

const HEALTH = ['on_track', 'at_risk', 'off_track'] as const;
const TONE: Record<StatusHealth, string> = { on_track: 'bg-openBg text-openInk', at_risk: 'bg-waitBg text-waitInk', off_track: 'bg-lateBg text-lateInk' };

/** Create or edit: a region or a team, how it is going, and a few lines. Edit changes only the health and the summary (the week and the scope stay). */
function UpdateDialog({ edit, onClose }: { edit: StatusUpdate | null; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const regions = useRegions();
  const ops = useStatusOps();
  const [scope, setScope] = useState<'region' | 'team'>(edit?.scope ?? 'region');
  const [region, setRegion] = useState(edit?.region_id ? String(edit.region_id) : '');
  const [team, setTeam] = useState<'cw' | 'te'>(edit?.team ?? 'cw');
  const [health, setHealth] = useState<StatusHealth>(edit?.health ?? 'on_track');
  const [summary, setSummary] = useState(edit?.summary ?? '');
  const busy = ops.post.isPending || ops.edit.isPending;
  const err = ops.post.error ?? ops.edit.error;
  const invalid = !summary.trim() || (!edit && scope === 'region' && !region);
  const done = () => { toast(t(edit ? 'weekly.saved' : 'weekly.posted')); onClose(); };
  const submit = () => {
    if (edit) ops.edit.mutate({ u: edit, health, summary: summary.trim() }, { onSuccess: done });
    else ops.post.mutate({ scope, health, summary: summary.trim(), ...(region ? { region_id: Number(region) } : {}), ...(scope === 'team' ? { team } : {}) }, { onSuccess: done });
  };
  return (
    <FormDialog open onClose={onClose} withReason={false} testid="status-dialog" title={t(edit ? 'weekly.edit_title' : 'weekly.new_title')} submitLabel={t('common.save')} disabled={invalid} busy={busy} onSubmit={submit}
      error={err ? (err.status === 403 ? t('weekly.only_leads') : errText(err, t)) : null}>
      {!edit && (
        <>
          <fieldset><legend className="text-sm font-semibold">{t('weekly.scope')}</legend>
            <div className="mt-1 flex gap-4 text-sm">{(['region', 'team'] as const).map((s) => (
              <label key={s} className="flex items-center gap-2"><input type="radio" name="status-scope" data-testid={`status-scope-${s}`} checked={scope === s} onChange={() => setScope(s)} />{t(`weekly.scope_${s}`)}</label>))}</div>
          </fieldset>
          <label className="block text-sm font-semibold">{t(scope === 'region' ? 'weekly.region' : 'weekly.region_optional')}
            <select className="input mt-1 font-normal" data-testid="status-region" value={region} onChange={(e) => setRegion(e.target.value)}>
              <option value="">{scope === 'region' ? t('weekly.choose') : t('sites.all_regions')}</option>
              {(regions.data ?? []).map((r) => <option key={r.id} value={r.id}>{(i18n.language === 'ar' && r.name_ar) || r.name_en}</option>)}
            </select>
          </label>
          {scope === 'team' && (
            <label className="block text-sm font-semibold">{t('weekly.team')}
              <select className="input mt-1 font-normal" data-testid="status-team" value={team} onChange={(e) => setTeam(e.target.value as 'cw' | 'te')}>
                {(['cw', 'te'] as const).map((x) => <option key={x} value={x}>{t(`weekly.team_${x}`)}</option>)}
              </select>
            </label>
          )}
        </>
      )}
      <fieldset><legend className="text-sm font-semibold">{t('weekly.health')}</legend>
        <div className="mt-1 flex flex-wrap gap-3 text-sm">{HEALTH.map((h) => (
          <label key={h} className="flex items-center gap-2"><input type="radio" name="status-health" data-testid={`status-health-${h}`} checked={health === h} onChange={() => setHealth(h)} /><span className={`chip ${TONE[h]}`}>{t(`weekly.health_${h}`)}</span></label>))}</div>
      </fieldset>
      <label className="block text-sm font-semibold">{t('weekly.summary')}
        <textarea className="input mt-1 min-h-28 font-normal" data-testid="status-summary" maxLength={4000} value={summary} onChange={(e) => setSummary(e.target.value)} />
        <span className="text-xs font-normal text-mute">{summary.length} / 4000</span>
      </label>
    </FormDialog>
  );
}

/** X7: the weekly status per region or team. Everyone who can read Sites reads; a lead (the reassign right) writes, and the author edits until the week ends. */
export function StatusUpdates() {
  const { t, i18n } = useTranslation();
  const me = useMe(true);
  const regions = useRegions();
  const [f, setF] = useState<StatusFilter>({ scope: '', region_id: '', team: '' });
  const q = useStatusUpdates(f);
  const [dialog, setDialog] = useState<null | { edit: StatusUpdate | null }>(null);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const lead = canReassign(me.data);
  const rname = (id: number | null) => { const r = regions.data?.find((x) => x.id === id); return (i18n.language === 'ar' && r?.name_ar) || r?.name_en || t('sites.all_regions'); };
  const weeks = [...new Set(items.map((i) => i.week_start))];
  return (
    <div data-testid="page-status-updates">
      <PageHeader title={t('weekly.title')} subtitle={t('weekly.subtitle')} />
      <Toolbar
        filters={<>
          <select className="input w-auto" aria-label={t('weekly.scope')} data-testid="status-filter-scope" value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value, team: e.target.value === 'region' ? '' : f.team })}>
            <option value="">{t('weekly.all_scopes')}</option><option value="region">{t('weekly.scope_region')}</option><option value="team">{t('weekly.scope_team')}</option>
          </select>
          <select className="input w-auto" aria-label={t('sites.all_regions')} data-testid="status-filter-region" value={f.region_id} onChange={(e) => setF({ ...f, region_id: e.target.value })}>
            <option value="">{t('sites.all_regions')}</option>{(regions.data ?? []).map((r) => <option key={r.id} value={r.id}>{(i18n.language === 'ar' && r.name_ar) || r.name_en}</option>)}
          </select>
        </>}
        primary={lead ? <button className="btn btn-primary" data-testid="status-new" onClick={() => setDialog({ edit: null })}><Plus size={16} aria-hidden />{t('weekly.new')}</button> : undefined}
      />
      {q.isLoading ? <LoadingSkeleton testid="status-loading" />
        : q.isError ? <ErrorState onRetry={() => void q.refetch()} testid="status-error" />
        : !items.length ? <EmptyState testid="status-empty" title={t('weekly.empty')} hint={t(lead ? 'weekly.empty_lead' : 'weekly.empty_hint')} />
        : weeks.map((w) => (
          <section key={w} className="mb-4" aria-label={w} data-testid={`status-week-${w}`}>
            <h2 className="mb-1 text-sm font-semibold text-mute"><span className="mono">{w}</span> → <span className="mono">{items.find((i) => i.week_start === w)?.week_end}</span></h2>
            <ul className="space-y-2">
              {items.filter((i) => i.week_start === w).map((u) => (
                <li key={u.id} className="card p-3" data-testid={`status-update-${u.id}`} data-health={u.health}>
                  <div className="flex flex-wrap items-center gap-2">
                    <b>{u.scope === 'region' ? rname(u.region_id) : `${t(`weekly.team_${u.team ?? 'cw'}`)} · ${u.region_id ? rname(u.region_id) : t('sites.all_regions')}`}</b>
                    <span className={`chip ${TONE[u.health]}`} data-testid={`status-health-chip-${u.id}`}>{t(`weekly.health_${u.health}`)}</span>
                    <span className="ms-auto text-sm text-mute">{t('weekly.by')} <PersonTag name={u.author.display_name} employeeId={u.author.employee_id} /></span>
                    {u.editable && <button className="btn px-2 py-1 text-xs" data-testid={`status-edit-${u.id}`} onClick={() => setDialog({ edit: u })}><Pencil size={14} aria-hidden />{t('common.edit')}</button>}
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm" data-testid={`status-summary-${u.id}`}>{u.summary}</p>
                </li>
              ))}
            </ul>
          </section>
        ))}
      {q.hasNextPage && <div className="text-center"><button className="btn" data-testid="status-more" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{t('inbox.more')}</button></div>}
      {dialog && <UpdateDialog edit={dialog.edit} onClose={() => setDialog(null)} />}
    </div>
  );
}
