import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useLabelLinks, useLabels } from '@/api/labels';
import { useSite } from '@/api/sites';
import { LabelChip } from '@/components/LabelPicker';

const MAX = 50;

function SiteLink({ id }: { id: string }) {
  const s = useSite(id);
  return <Link className="text-accentText underline" to={`/sites/${id}`}>{s.data ? <><b className="mono">{s.data.site_code}</b> {s.data.name}</> : id.slice(0, 8)}</Link>;
}

/**
 * My labels (item 2): the caller's own labels with the records on each, so a label works as a filter and the list is grouped by label. Choose one label to filter, or
 * all to group. Sites open the site; register records open their register. Personal: nobody else sees it.
 */
export function MyLabels() {
  const { t } = useTranslation();
  const labels = useLabels();
  const sites = useLabelLinks('site');
  const regs = useLabelLinks('register_record');
  const [only, setOnly] = useState('');
  const shown = (labels.data ?? []).filter((l) => !only || l.id === only);
  return (
    <section className="space-y-4" data-testid="page-my-labels">
      <div>
        <h2 className="text-lg font-bold">{t('labels.page_title')}</h2>
        <p className="text-mute">{t('labels.personal')}</p>
      </div>
      <label className="flex items-center gap-2 text-sm">{t('labels.filter')}
        <select className="input w-auto py-1" value={only} data-testid="labels-filter" onChange={(e) => setOnly(e.target.value)}>
          <option value="">{t('labels.all')}</option>
          {(labels.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </label>
      {labels.isSuccess && !labels.data.length && <p className="text-mute" data-testid="labels-empty">{t('labels.none')}</p>}
      {shown.map((l) => {
        const s = (sites.data ?? []).filter((x) => x.label_ids.includes(l.id));
        const r = (regs.data ?? []).filter((x) => x.label_ids.includes(l.id));
        return (
          <div key={l.id} className="card space-y-2 p-3" data-testid={`labels-group-${l.name}`}>
            <h3 className="flex items-center gap-2 font-semibold"><LabelChip l={l} /><span className="text-mute">({s.length + r.length})</span></h3>
            <ul className="space-y-1 text-sm">
              {s.slice(0, MAX).map((x) => <li key={x.ref_id}><SiteLink id={x.ref_id} /></li>)}
              {r.slice(0, MAX).map((x) => <li key={x.ref_id}>{x.context ? <Link className="text-accentText underline" to={`/registers/${x.context}?record=${x.ref_id}`}>{t('labels.record_in', { register: x.context })}</Link> : x.ref_id}</li>)}
              {s.length + r.length === 0 && <li className="text-mute">{t('labels.empty_label')}</li>}
              {(s.length > MAX || r.length > MAX) && <li className="text-mute">{t('labels.more', { count: MAX })}</li>}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
