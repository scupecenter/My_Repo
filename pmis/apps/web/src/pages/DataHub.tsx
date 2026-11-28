import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useMe } from '@/api/hooks';
import { useDataHubSettings, useDataHubSummary, type DataHubBatch } from '@/api/dataHub';
import { useDataReset } from '@/api/dataReset';
import { useIntegrityRuns } from '@/api/logs';
import { useMasterRuns } from '@/api/masterImport';
import { useRecycleBin } from '@/api/recycleBin';
import { useBatches, useTemplates } from '@/api/registers';
import { useExports } from '@/api/admin';
import { useStructureProposals } from '@/api/structureProposals';
import { batchPath } from '@/api/types';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/States';
import { TemplateQuickBar } from '@/components/TemplateQuickBar';
import { ICONS, ICON_PROPS, type Concept } from '@/lib/icons';
import { isAdmin } from '@/lib/perm';

const dateOf = (iso?: string | null) => (iso ? iso.slice(0, 10) : '-');

function Widget({ id, icon, title, badge, link, children }: { id: string; icon: Concept; title: string; badge?: number; link?: { to: string; label: string }; children: ReactNode }) {
  const Icon = ICONS[icon];
  return (
    <section className="card flex flex-col gap-2 p-4" data-testid={`hub-widget-${id}`} aria-labelledby={`hub-w-${id}`}>
      <div className="flex items-center gap-2">
        <Icon {...ICON_PROPS} size={18} className="shrink-0" />
        <h2 id={`hub-w-${id}`} className="min-w-0 flex-1 truncate text-base font-bold">{title}</h2>
        {badge !== undefined && badge > 0 && <span className="rounded-full bg-lateBg px-2 text-xs font-bold text-lateInk" data-testid={`hub-badge-${id}`}>{badge}</span>}
        {link && <Link to={link.to} className="text-xs text-link" data-testid={`hub-more-${id}`}>{link.label}</Link>}
      </div>
      {children}
    </section>
  );
}

/**
 * The Data hub landing page: five widgets (batches that need an action, template changes, recent uploads and exports, data health, the admin section) and the
 * quick download bar. No analytic charts (those belong to the Dashboard). Each widget can be hidden in Settings > Screens > Data hub.
 */
export function DataHubPage() {
  const { t, i18n } = useTranslation();
  const me = useMe(true);
  const admin = isAdmin(me.data);
  const cfg = useDataHubSettings();
  const w = cfg.widgets;
  const summary = useDataHubSummary();
  const batches = useBatches({ status: '', template_id: '', register_key: '', stream: '' }, w.recent);
  const templates = useTemplates();
  const exportsQ = useExports(w.recent);
  const runs = useIntegrityRuns();
  const master = useMasterRuns();
  const reset = useDataReset(admin && w.admin);
  const bin = useRecycleBin();
  const structure = useStructureProposals(admin && w.admin);
  const structPending = (structure.data ?? []).filter((p) => p.status === 'pending').length;
  const nameOf = (x: { name_en: string; name_ar?: string | null }) => (i18n.language === 'ar' && x.name_ar) || x.name_en;
  const tplName = (id: string) => { const x = templates.data?.find((y) => y.template_id === id); return x ? nameOf(x) : id; };
  const s = summary.data;
  const actionLabel = (b: DataHubBatch) => t(`dhub.act_${b.action}`);
  const anyWidget = w.quick_bar || w.batches || w.template_changes || w.recent || w.health || (w.admin && admin);

  const recent = (batches.data?.items ?? []).slice(0, 5);
  const exps = (exportsQ.data ?? []).slice(0, 5);
  const lastRun = (runs.data ?? [])[0];
  const openDiffs = (master.data?.items ?? []).filter((r) => r.status === 'previewed').length;
  const held = (batches.data?.items ?? []).reduce((n, b) => n + (((b as { counts?: { held?: number } }).counts?.held) ?? 0), 0);
  const binCount = bin.data?.items.length ?? 0;

  return (
    <div data-testid="page-data-hub">
      <PageHeader title={t('dhub.title')} subtitle={t('dhub.subtitle')} settings="data_hub" />
      <p className="mb-3 text-sm"><Link to="/reports" className="text-link" data-testid="hub-reports-link">{t('reports.title')}</Link> <span className="text-mute">{t('reports.hub_hint')}</span></p>
      {!anyWidget && <EmptyState title={t('dhub.all_hidden')} />}
      {w.quick_bar && (
        <section className="card mb-4 p-4" data-testid="hub-widget-quick_bar" aria-label={t('dhub.quick_title')}>
          <h2 className="mb-2 text-base font-bold">{t('dhub.quick_title')}</h2>
          <TemplateQuickBar testid="hub-quickbar" />
          {(s?.my_downloads.length ?? 0) > 0 && (
            <p className="mt-2 text-xs text-mute" data-testid="hub-my-downloads">
              {t('dhub.my_downloads')}: {s!.my_downloads.slice(0, 5).map((d) => `${tplName(d.template_id)}${d.version ? ` v${d.version}` : ''}${d.prefill ? ` (${t('dhub.prefilled')})` : ''} ${dateOf(d.at)}`).join(' · ')}
            </p>
          )}
        </section>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {w.batches && (
          <Widget id="batches" icon="waiting" title={t('dhub.w_batches')} badge={s?.batches.count} link={{ to: '/templates', label: t('dhub.open_all') }}>
            {summary.isLoading ? <LoadingSkeleton /> : summary.isError ? <ErrorState onRetry={() => void summary.refetch()} /> : !s?.batches.items.length ? <p className="text-sm text-mute" data-testid="hub-batches-empty">{t('dhub.batches_none')}</p> : (
              <ul className="space-y-1 text-sm">{s.batches.items.map((b) => (
                <li key={b.id} className="flex items-center gap-2">
                  <Link className="min-w-0 flex-1 truncate text-link" to={batchPath({ id: b.id, register_key: b.register_key ?? null, stream: b.stream ?? null })}>{b.file_name}</Link>
                  <span className="rounded bg-waitBg px-1.5 text-xs text-waitInk">{actionLabel(b)}</span>
                </li>))}</ul>)}
          </Widget>
        )}
        {w.template_changes && (
          <Widget id="template_changes" icon="templateChanged" title={t('dhub.w_changes')} link={{ to: '/templates', label: t('dhub.open_templates') }}>
            {!s?.template_changes.length ? <p className="text-sm text-mute" data-testid="hub-changes-empty">{t('dhub.changes_none')}</p> : (
              <ul className="space-y-1 text-sm">{s.template_changes.map((c) => (
                <li key={c.template_id} data-testid={`hub-change-${c.template_id}`}>
                  <span className="font-semibold">{nameOf(c)}</span> v{c.version} <span className="text-xs text-mute">{dateOf(c.issued_at)}</span>
                  <span className="block text-xs text-mute">{t('dhub.change_diff', { added: c.added.length, removed: c.removed.length, renamed: c.renamed.length })}{c.mine_is_old ? ` · ${t('dhub.mine_old')}` : ''}</span>
                </li>))}</ul>)}
          </Widget>
        )}
        {w.recent && (
          <Widget id="recent" icon="upload" title={t('dhub.w_recent')} link={{ to: '/templates', label: t('dhub.open_all') }}>
            {!recent.length && !exps.length ? <p className="text-sm text-mute" data-testid="hub-recent-empty">{t('dhub.recent_none')}</p> : (
              <ul className="space-y-1 text-sm">
                {recent.map((b) => <li key={b.id} className="flex gap-2"><Link className="min-w-0 flex-1 truncate text-link" to={batchPath(b)}>{b.file_name}</Link><span className="text-xs text-mute">{b.status}</span></li>)}
                {exps.map((e) => <li key={e.id} className="flex gap-2"><span className="min-w-0 flex-1 truncate">{t('dhub.export_row', { kind: e.kind })}</span><span className="text-xs text-mute">{e.status} · {dateOf(e.created_at)}</span></li>)}
              </ul>)}
          </Widget>
        )}
        {w.health && (
          <Widget id="health" icon="dataHealth" title={t('dhub.w_health')}>
            <dl className="grid grid-cols-2 gap-1 text-sm" data-testid="hub-health">
              <dt className="text-mute">{t('dhub.h_held')}</dt><dd>{held}</dd>
              <dt className="text-mute">{t('dhub.h_diffs')}</dt><dd>{admin ? openDiffs : '-'}</dd>
              <dt className="text-mute">{t('dhub.h_integrity')}</dt><dd>{admin ? (lastRun ? `${lastRun.status} · ${dateOf(lastRun.started_at)}` : '-') : '-'}</dd>
            </dl>
          </Widget>
        )}
        {w.admin && admin && (
          <Widget id="admin" icon="locked" title={t('dhub.w_admin')}>
            <div className="flex flex-wrap gap-2">
              <Link to="/admin/settings/data/reset" className="btn px-2 py-1 text-sm" data-testid="hub-link-data-reset">{(() => { const I = ICONS.dataReset; return <I {...ICON_PROPS} size={16} />; })()}{t('nav.data_reset')}{reset.data?.request ? ` (${reset.data.request.status})` : ''}</Link>
              <Link to="/admin/settings/registers/recycle" className="btn px-2 py-1 text-sm" data-testid="hub-link-recycle-bin">{(() => { const I = ICONS.recycleBin; return <I {...ICON_PROPS} size={16} />; })()}{t('nav.recycle_bin')}{binCount ? ` (${binCount})` : ''}</Link>
              <Link to="/admin/settings/data/structure" className="btn px-2 py-1 text-sm" data-testid="hub-link-structure">{(() => { const I = ICONS.template; return <I {...ICON_PROPS} size={16} />; })()}{t('settings.section_data_structure')}{structPending ? ` (${structPending})` : ''}</Link>
            </div>
            <p className="text-xs text-mute">{t('dhub.admin_note')}</p>
          </Widget>
        )}
      </div>
    </div>
  );
}
