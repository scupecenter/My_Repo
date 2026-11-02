import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { EMPTY_FILTER, VIAS, type LogFilter } from '@/api/logs';
import { useRegions } from '@/api/sites';
import { PeoplePicker } from '@/components/PeoplePicker';
import { SitePicker } from '@/components/RegisterFields';
import { ActiveChips, type Chip } from '@/components/TableKit';

export const ENTITY_TYPES = ['task', 'register_record', 'site', 'user', 'role', 'setting', 'template', 'document'];
export const ACTIONS = ['task.submit', 'task.approve', 'task.reject', 'task.update', 'record.update', 'record.approve', 'user.session_revoked', 'settings.update', 'document.download', 'export.create', 'audit_log.read'];

function L({ k, children }: { k: string; children: ReactNode }) {
  const { t } = useTranslation();
  return <label className="block text-sm font-semibold">{t(k)}<div className="mt-1 font-normal">{children}</div></label>;
}

/** Filters of the Audit Log (kind=audit) and of Field changes (kind=field): who, entity, site, region, dates, via, ip, and free text or field. */
export function LogFilters({ kind, f, set }: { kind: 'audit' | 'field'; f: LogFilter; set: (f: LogFilter) => void }) {
  const { t, i18n } = useTranslation();
  const regions = useRegions().data ?? [];
  const [open, setOpen] = useState(false);
  const up = (p: Partial<LogFilter>) => set({ ...f, ...p });
  const rows: ([string, string, Partial<LogFilter>] | false | '' | null)[] = [
    f.actor && ['actor', `${t('logs.f_who')}: ${f.actor.display_name}`, { actor: null }],
    f.site && ['site', `${t('logs.f_site')}: ${f.site.code}`, { site: null }],
    f.region && ['region', `${t('logs.f_region')}: ${regions.find((r) => String(r.id) === f.region)?.name_en ?? f.region}`, { region: '' }],
    f.entity_type && ['entity_type', `${t('logs.f_entity')}: ${f.entity_type}`, { entity_type: '' }],
    f.entity_id && ['entity_id', `${t('logs.f_entity_id')}: ${f.entity_id}`, { entity_id: '' }],
    kind === 'audit' && f.action && ['action', `${t('logs.f_action')}: ${f.action}`, { action: '' }],
    kind === 'field' && f.field && ['field', `${t('logs.f_field')}: ${f.field}`, { field: '' }],
    f.from && ['from', `${t('logs.f_from')}: ${f.from}`, { from: '' }],
    f.to && ['to', `${t('logs.f_to')}: ${f.to}`, { to: '' }],
    f.via && ['via', `${t('logs.f_via')}: ${t(`logs.via_${f.via}`)}`, { via: '' }],
    f.ip && ['ip', `IP: ${f.ip}`, { ip: '' }],
    kind === 'audit' && f.q && ['q', `${t('logs.f_search')}: ${f.q}`, { q: '' }],
  ];
  const chips: Chip[] = rows.filter((x): x is [string, string, Partial<LogFilter>] => !!x).map(([key, label, patch]) => ({ key, label, onRemove: () => up(patch) }));
  const regionName = (r: { name_en: string; name_ar?: string | null }) => (i18n.language === 'ar' && r.name_ar) || r.name_en;
  return (
    <section className="card mb-3 space-y-3 p-3" data-testid="log-filters" aria-label={t('logs.filters')}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1">
          {kind === 'audit'
            ? <L k="logs.f_search"><input className="input" data-testid="f-q" placeholder={t('logs.f_search_hint')} value={f.q} onChange={(e) => up({ q: e.target.value })} /></L>
            : <L k="logs.f_field"><input className="input" dir="ltr" data-testid="f-field" placeholder="planned_date" value={f.field} onChange={(e) => up({ field: e.target.value })} /></L>}
        </div>
        <L k="logs.f_from"><input type="date" className="input" data-testid="f-from" value={f.from} onChange={(e) => up({ from: e.target.value })} /></L>
        <L k="logs.f_to"><input type="date" className="input" data-testid="f-to" value={f.to} onChange={(e) => up({ to: e.target.value })} /></L>
        <L k="logs.f_via"><select className="input" data-testid="f-via" value={f.via} onChange={(e) => up({ via: e.target.value })}><option value="">{t('common.all')}</option>{VIAS.map((v) => <option key={v} value={v}>{t(`logs.via_${v}`)}</option>)}</select></L>
        <button type="button" className="btn" data-testid="f-more" aria-expanded={open} onClick={() => setOpen(!open)}>{t(open ? 'logs.f_less' : 'logs.f_more')}</button>
      </div>
      {open && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="f-advanced">
          <L k="logs.f_who"><PeoplePicker id="f-who" single value={f.actor ? [f.actor] : []} onChange={(v) => up({ actor: v[0] ?? null })} /></L>
          <L k="logs.f_site"><SitePicker value={f.site} onChange={(s) => up({ site: s ? { id: s.id, code: s.code } : null })} /></L>
          <L k="logs.f_region"><select className="input" data-testid="f-region" value={f.region} onChange={(e) => up({ region: e.target.value })}><option value="">{t('common.all')}</option>{regions.map((r) => <option key={r.id} value={r.id}>{regionName(r)}</option>)}</select></L>
          <L k="logs.f_entity"><select className="input" data-testid="f-entity" value={f.entity_type} onChange={(e) => up({ entity_type: e.target.value })}><option value="">{t('common.all')}</option>{ENTITY_TYPES.map((x) => <option key={x} value={x}>{x}</option>)}</select></L>
          <L k="logs.f_entity_id"><input className="input mono" dir="ltr" data-testid="f-entity-id" value={f.entity_id} onChange={(e) => up({ entity_id: e.target.value })} /></L>
          {kind === 'audit' && <L k="logs.f_action"><input className="input" dir="ltr" list="log-actions" data-testid="f-action" value={f.action} onChange={(e) => up({ action: e.target.value })} /><datalist id="log-actions">{ACTIONS.map((a) => <option key={a} value={a} />)}</datalist></L>}
          <L k="logs.f_ip"><input className="input mono" dir="ltr" data-testid="f-ip" placeholder="10.20.1." value={f.ip} onChange={(e) => up({ ip: e.target.value })} /></L>
        </div>
      )}
      <ActiveChips chips={chips} onClear={() => set(EMPTY_FILTER)} />
    </section>
  );
}
