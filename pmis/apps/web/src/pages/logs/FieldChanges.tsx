import * as Dialog from '@radix-ui/react-dialog';
import { ArrowRight, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EMPTY_FILTER, useFieldChanges, type FieldChange, type LogFilter } from '@/api/logs';
import { useRegions } from '@/api/sites';
import { DrawerFrame } from '@/components/DrawerFrame';
import { DeviceIcon, deviceText, stamp, valueText, ViaChip, Who } from '@/components/logs/bits';
import { LogFilters } from '@/components/logs/LogFilters';
import { LogTable } from '@/components/logs/LogTable';
import { SavedViews } from '@/components/logs/SavedViews';
import { PageHeader, Toolbar } from '@/components/PageHeader';
import { ColumnMenu, useTablePrefs } from '@/components/TableKit';
import type { ColDef } from '@/lib/tablePrefs';

const DEFS: ColDef[] = [
  { id: 'at', w: 160, min: 110, pinned: true }, { id: 'site', w: 90, min: 60 }, { id: 'entity', w: 170, min: 90 }, { id: 'field', w: 150, min: 80 }, { id: 'change', w: 250, min: 120 }, { id: 'actor', w: 210, min: 120 },
  { id: 'via', w: 100, min: 70 }, { id: 'device', w: 70, min: 50 }, { id: 'ip', w: 120, min: 80 }, { id: 'reason', w: 220, min: 90, off: true }, { id: 'region', w: 100, min: 60, off: true },
];

const KV = ({ k, v, id }: { k: string; v: React.ReactNode; id: string }) => <div className="flex justify-between gap-3 border-b border-line py-1" data-testid={`fc-${id}`}><span className="text-mute">{k}</span><span className="text-end" dir="auto">{v}</span></div>;

function Detail({ r, onClose }: { r: FieldChange; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const field = (i18n.language === 'ar' && r.field_label_ar) || r.field_label_en;
  return (
    <div className="flex h-full flex-col" data-testid="fc-drawer-body">
      <header className="flex items-start gap-2 border-b border-line p-4">
        <div className="flex-1"><Dialog.Title className="font-bold">{field}</Dialog.Title><Dialog.Description className="text-sm text-mute">{r.entity_label}</Dialog.Description></div>
        <Dialog.Close asChild><button className="btn px-2" aria-label={t('common.close')} data-testid="fc-drawer-close" onClick={onClose}><X size={16} /></button></Dialog.Close>
      </header>
      <div className="flex-1 space-y-3 overflow-y-auto p-4 text-sm">
        <div className="flex items-center gap-2 text-base font-semibold" dir="auto"><span className="mono">{valueText(r.old_value)}</span><ArrowRight size={16} className="rtl:rotate-180" aria-hidden /><span className="mono">{valueText(r.new_value)}</span></div>
        <KV id="when" k={t('logs.c_at')} v={<span dir="ltr">{stamp(r.at)}</span>} />
        <KV id="actor" k={t('logs.c_actor')} v={<Who a={r.actor} />} />
        {r.on_behalf_of && <KV id="behalf" k={t('logs.on_behalf')} v={<Who a={r.on_behalf_of} />} />}
        <KV id="via" k={t('logs.c_via')} v={<ViaChip via={r.via} />} />
        <KV id="device" k={t('logs.c_device')} v={<span className="inline-flex items-center gap-1"><DeviceIcon device={r.device} />{deviceText(r.device)}</span>} />
        <KV id="ip" k="IP" v={<span className="mono" dir="ltr">{r.ip ?? '—'}</span>} />
        <KV id="session" k={t('logs.c_session')} v={<span className="mono text-xs" dir="ltr">{r.session_id ?? '—'}</span>} />
        <KV id="auth" k={t('logs.c_auth')} v={t(`logs.auth_${r.auth_method}`)} />
        <KV id="mfa" k="MFA" v={r.mfa ? t('common.yes') : t('common.no')} />
        {r.reason && <KV id="reason" k={t('common.reason')} v={r.reason} />}
        {r.batch_id && <KV id="batch" k={t('logs.c_batch')} v={<span className="mono text-xs" dir="ltr">{r.batch_id}</span>} />}
      </div>
    </div>
  );
}

/** "Who changed the Power-On date of site X, from what to what, when, and from which device." */
export function FieldChanges() {
  const { t, i18n } = useTranslation();
  const regions = useRegions().data ?? [];
  const [f, setF] = useState<LogFilter>(EMPTY_FILTER);
  const q = useFieldChanges(f);
  const tbl = useTablePrefs('field-changes', DEFS);
  const [sel, setSel] = useState<FieldChange | null>(null);
  const ar = i18n.language === 'ar';
  const cell = (r: FieldChange, c: string) => {
    switch (c) {
      case 'at': return <span className="mono text-xs" dir="ltr">{stamp(r.at)}</span>;
      case 'site': return <span className="mono">{r.site_code ?? '—'}</span>;
      case 'entity': return r.entity_label;
      case 'field': return (ar && r.field_label_ar) || r.field_label_en;
      case 'change': return <span className="inline-flex items-center gap-1" dir="auto"><span className="mono text-lateInk" data-testid={`fc-old-${r.id}`}>{valueText(r.old_value)}</span><ArrowRight size={12} aria-hidden className="shrink-0 rtl:rotate-180" /><span className="mono font-semibold" data-testid={`fc-new-${r.id}`}>{valueText(r.new_value)}</span></span>;
      case 'actor': return <Who a={r.actor} />;
      case 'via': return <ViaChip via={r.via} />;
      case 'device': return <DeviceIcon device={r.device} />;
      case 'ip': return <span className="mono text-xs" dir="ltr">{r.ip ?? '—'}</span>;
      case 'reason': return r.reason ?? '—';
      default: { const g = regions.find((x) => x.id === r.region_id); return g ? ((ar && g.name_ar) || g.name_en) : '—'; }
    }
  };
  return (
    <div data-testid="page-field-changes">
      <PageHeader title={t('nav.logs.field_changes')} subtitle={t('logs.fc_subtitle')} />
      <Toolbar filters={<SavedViews screen="field-changes" value={f} onApply={setF} empty={EMPTY_FILTER} table={tbl} />}
        count={<span className="text-sm text-mute" data-testid="fc-count">{t('logs.shown', { count: q.items.length })}</span>} tools={<ColumnMenu api={tbl} label={(id) => t(`logs.c_${id}`)} />} />
      <LogFilters kind="field" f={f} set={setF} />
      <LogTable tbl={tbl} label={(id) => t(`logs.c_${id}`)} rows={q.items} rowId={(r) => r.id} cell={cell} onOpen={setSel} activeId={sel?.id} testid="fc-table"
        loading={q.isLoading} error={q.isError} onRetry={() => void q.refetch()} hasMore={q.hasNextPage} onMore={() => void q.fetchNextPage()} loadingMore={q.isFetchingNextPage} />
      <DrawerFrame name="field-change" testid="fc-drawer" open={!!sel} onClose={() => setSel(null)}>{sel && <Detail r={sel} onClose={() => setSel(null)} />}</DrawerFrame>
    </div>
  );
}
