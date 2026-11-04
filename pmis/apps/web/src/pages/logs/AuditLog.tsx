import * as Dialog from '@radix-ui/react-dialog';
import { Download, ShieldCheck, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMe } from '@/api/hooks';
import { EMPTY_FILTER, exportAuditLog, useAuditLog, type AuditRow, type LogFilter } from '@/api/logs';
import { useVerifyIntegrity } from '@/api/settings';
import { useRegions } from '@/api/sites';
import type { LogIntegrity } from '@/api/types';
import { DrawerFrame } from '@/components/DrawerFrame';
import { errText } from '@/components/FormDialog';
import { DeviceIcon, stamp, valueText, ViaChip, Who, deviceText } from '@/components/logs/bits';
import { LogFilters } from '@/components/logs/LogFilters';
import { LogTable } from '@/components/logs/LogTable';
import { SavedViews } from '@/components/logs/SavedViews';
import { PageHeader, Toolbar } from '@/components/PageHeader';
import { ColumnMenu, useTablePrefs } from '@/components/TableKit';
import { useToast } from '@/components/Toast';
import { hasGrant, isAdmin } from '@/lib/perm';
import type { ColDef } from '@/lib/tablePrefs';
import { IntegrityCard } from '../SecurityLog';

const DEFS: ColDef[] = [
  { id: 'at', w: 160, min: 110, pinned: true }, { id: 'actor', w: 210, min: 120 }, { id: 'action', w: 150, min: 90 }, { id: 'entity', w: 130, min: 80 }, { id: 'site', w: 90, min: 60 }, { id: 'region', w: 100, min: 60 },
  { id: 'via', w: 100, min: 70 }, { id: 'device', w: 70, min: 50 }, { id: 'ip', w: 120, min: 80 }, { id: 'flags', w: 170, min: 90 }, { id: 'reason', w: 220, min: 90, off: true }, { id: 'id', w: 80, min: 50, off: true },
];

/** Before and after side by side; a changed key is highlighted and marked for screen readers. */
export function Diff({ before, after }: { before?: Record<string, unknown> | null; after?: Record<string, unknown> | null }) {
  const { t } = useTranslation();
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  if (!keys.length) return <p className="text-mute" data-testid="diff-empty">{t('logs.no_diff')}</p>;
  return (
    <table className="w-full text-sm" data-testid="audit-diff">
      <thead className="text-mute"><tr><th className="p-1 text-start">{t('logs.d_field')}</th><th className="p-1 text-start">{t('logs.d_before')}</th><th className="p-1 text-start">{t('logs.d_after')}</th></tr></thead>
      <tbody>
        {keys.map((k) => {
          const changed = JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]);
          return (
            <tr key={k} data-testid={`diff-row-${k}`} data-changed={changed} className={changed ? 'bg-waitBg' : ''}>
              <td className="mono p-1" dir="ltr">{k}{changed && <span className="sr-only"> ({t('logs.d_changed')})</span>}</td>
              <td className={`mono p-1 ${changed ? 'text-lateInk line-through' : ''}`} dir="auto" data-testid={`diff-before-${k}`}>{valueText(before?.[k])}</td>
              <td className={`mono p-1 ${changed ? 'font-bold text-doneInk' : ''}`} dir="auto" data-testid={`diff-after-${k}`}>{valueText(after?.[k])}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const KV = ({ k, v, id }: { k: string; v: React.ReactNode; id: string }) => <div className="flex justify-between gap-3 border-b border-line py-1" data-testid={`ad-${id}`}><span className="text-mute">{k}</span><span className="text-end" dir="auto">{v}</span></div>;

function Detail({ r, onClose, region }: { r: AuditRow; onClose: () => void; region: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col" data-testid="audit-drawer-body">
      <header className="flex items-start gap-2 border-b border-line p-4">
        <div className="flex-1">
          <Dialog.Title className="font-bold"><span className="mono" dir="ltr">{r.action}</span> <span className="text-mute">#{r.id}</span></Dialog.Title>
          <Dialog.Description className="mt-1 flex flex-wrap gap-1 text-sm">
            {r.self_approval && <span className="chip bg-lateBg text-lateInk" data-testid="ad-self-approval">{t('logs.self_approval')}</span>}
            {r.is_admin_override && <span className="chip bg-waitBg text-waitInk">{t('logs.admin_override')}</span>}
            {r.privileged && <span className="chip bg-card2">{t('logs.privileged')}</span>}
            {r.stepup_verified && <span className="chip bg-card2">{t('logs.stepup')}</span>}
          </Dialog.Description>
        </div>
        <Dialog.Close asChild><button className="btn px-2" aria-label={t('common.close')} data-testid="audit-drawer-close" onClick={onClose}><X size={16} /></button></Dialog.Close>
      </header>
      <div className="flex-1 space-y-4 overflow-y-auto p-4 text-sm">
        <section aria-label={t('logs.d_diff')}>
          <h3 className="mb-1 font-semibold">{t('logs.d_diff')}</h3>
          <Diff before={r.before} after={r.after} />
        </section>
        <section aria-label={t('logs.d_who')}>
          <KV id="when" k={t('logs.c_at')} v={<span dir="ltr">{stamp(r.at)}</span>} />
          <KV id="actor" k={t('logs.c_actor')} v={<Who a={r.actor} />} />
          {r.on_behalf_of && <KV id="behalf" k={t('logs.on_behalf')} v={<Who a={r.on_behalf_of} />} />}
          <KV id="entity" k={t('logs.c_entity')} v={`${r.entity_type}${r.entity_id ? ` · ${r.entity_id}` : ''}`} />
          <KV id="site" k={t('logs.c_site')} v={`${r.site_code ?? '—'} · ${region}`} />
          {r.reason && <KV id="reason" k={t('common.reason')} v={r.reason} />}
        </section>
        <section aria-label={t('logs.d_context')}>
          <h3 className="mb-1 font-semibold">{t('logs.d_context')}</h3>
          <KV id="via" k={t('logs.c_via')} v={<ViaChip via={r.via} />} />
          <KV id="device" k={t('logs.c_device')} v={<span className="inline-flex items-center gap-1"><DeviceIcon device={r.device} />{deviceText(r.device) || '—'}</span>} />
          <KV id="ip" k="IP" v={<span className="mono" dir="ltr">{r.ip ?? '—'}</span>} />
          <KV id="session" k={t('logs.c_session')} v={<span className="mono text-xs" dir="ltr">{r.session_id ?? '—'}</span>} />
          <KV id="auth" k={t('logs.c_auth')} v={r.auth_method ? t(`logs.auth_${r.auth_method}`) : '—'} />
          <KV id="mfa" k="MFA" v={r.mfa ? t('common.yes') : t('common.no')} />
          <KV id="request" k={t('logs.c_request')} v={<span className="mono text-xs" dir="ltr">{r.request_id ?? '—'}</span>} />
        </section>
      </div>
    </div>
  );
}

export function AuditLog() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const me = useMe(true);
  const regions = useRegions().data ?? [];
  const [f, setF] = useState<LogFilter>(EMPTY_FILTER);
  const q = useAuditLog(f);
  const tbl = useTablePrefs('audit-log', DEFS);
  const [sel, setSel] = useState<AuditRow | null>(null);
  const verify = useVerifyIntegrity();
  const [res, setRes] = useState<LogIntegrity | null>(null);
  const [exporting, setExporting] = useState(false);
  const admin = isAdmin(me.data), canExport = admin || hasGrant(me.data, 'export');
  const region = (id?: number | null) => { const r = regions.find((x) => x.id === id); return r ? ((i18n.language === 'ar' && r.name_ar) || r.name_en) : '—'; };
  const cell = (r: AuditRow, c: string) => {
    switch (c) {
      case 'at': return <span className="mono text-xs" dir="ltr">{stamp(r.at)}</span>;
      case 'actor': return <Who a={r.actor} />;
      case 'action': return <span className="mono text-xs" dir="ltr">{r.action}</span>;
      case 'entity': return r.entity_type;
      case 'site': return <span className="mono">{r.site_code ?? '—'}</span>;
      case 'region': return region(r.region_id);
      case 'via': return <ViaChip via={r.via} />;
      case 'device': return <DeviceIcon device={r.device} />;
      case 'ip': return <span className="mono text-xs" dir="ltr">{r.ip ?? '—'}</span>;
      case 'flags': return <span className="flex flex-wrap gap-1">{r.self_approval && <span className="chip bg-lateBg text-lateInk" data-testid={`flag-self-${r.id}`}>{t('logs.self_approval')}</span>}{r.is_admin_override && <span className="chip bg-waitBg text-waitInk">{t('logs.admin_override')}</span>}{r.on_behalf_of && <span className="chip bg-card2">{t('logs.on_behalf')}</span>}</span>;
      case 'reason': return r.reason ?? '—';
      default: return <span className="mono text-xs">{r.id}</span>;
    }
  };
  const doExport = () => { setExporting(true); exportAuditLog(f).then(() => toast(t('logs.exported'))).catch((e) => toast(errText(e, t), 'err')).finally(() => setExporting(false)); };
  const check = () => verify.mutate('audit', { onSuccess: setRes, onError: (e) => toast(errText(e, t), 'err') });
  return (
    <div data-testid="page-audit-log">
      <PageHeader title={t('nav.audit')} subtitle={t('logs.audit_subtitle')} />
      <Toolbar
        filters={<SavedViews screen="audit-log" value={f} onApply={setF} empty={EMPTY_FILTER} table={tbl} />}
        count={<span className="text-sm text-mute" data-testid="audit-count">{t('logs.shown', { count: q.items.length })}</span>}
        tools={<>
          <ColumnMenu api={tbl} label={(id) => t(`logs.c_${id}`)} />
          {admin && <button className="btn" data-testid="audit-integrity" disabled={verify.isPending} onClick={check}><ShieldCheck size={14} />{t('logs.integrity')}</button>}
          {canExport && <button className="btn" data-testid="audit-export" disabled={exporting} onClick={doExport}><Download size={14} />{t('logs.export')}</button>}
        </>} />
      {res && <div className="mb-3" data-testid="audit-integrity-result"><IntegrityCard r={res} /></div>}
      <LogFilters kind="audit" f={f} set={setF} />
      <LogTable tbl={tbl} label={(id) => t(`logs.c_${id}`)} rows={q.items} rowId={(r) => String(r.id)} cell={cell} onOpen={setSel} activeId={sel ? String(sel.id) : null} testid="audit-table"
        loading={q.isLoading} error={q.isError} onRetry={() => void q.refetch()} hasMore={q.hasNextPage} onMore={() => void q.fetchNextPage()} loadingMore={q.isFetchingNextPage} />
      <DrawerFrame name="audit" testid="audit-drawer" open={!!sel} onClose={() => setSel(null)}>
        {sel && <Detail r={sel} onClose={() => setSel(null)} region={region(sel.region_id as number | null)} />}
      </DrawerFrame>
    </div>
  );
}
