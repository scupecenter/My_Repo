import { Tag } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { LABEL_COLOURS, useLabelLinks, useLabelOps, useLabels, type Label, type LabelColour, type LabelKind } from '@/api/labels';
import { useToast } from './Toast';

export const LABEL_TONE: Record<LabelColour, string> = {
  red: 'bg-lateBg text-lateInk', orange: 'bg-waitBg text-waitInk', amber: 'bg-waitBg text-waitInk', green: 'bg-doneBg text-doneInk', teal: 'bg-openBg text-openInk',
  blue: 'bg-openBg text-openInk', purple: 'bg-lockBg text-lockInk', pink: 'bg-lateBg text-lateInk', grey: 'bg-card2 text-mute',
};
const DOT: Record<LabelColour, string> = { red: '#dc2626', orange: '#ea580c', amber: '#d97706', green: '#16a34a', teal: '#0d9488', blue: '#2563eb', purple: '#7c3aed', pink: '#db2777', grey: '#6b7280' };

/** A label: the colour is a dot plus the name, so the colour is never the only signal. */
export function LabelChip({ l }: { l: Pick<Label, 'name' | 'colour'> }) {
  return <span className={`chip gap-1 ${LABEL_TONE[l.colour]}`} data-testid={`label-chip-${l.name}`}><span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: DOT[l.colour] }} />{l.name}</span>;
}

/**
 * Improvement list item 2: the caller's own coloured labels on a record. Chips show the labels on it; the button opens a small panel to tick labels, make a new one
 * (name and colour) or hide one. Labels are personal: nobody else sees them, so this changes no one's access. Quiet when the labels cannot be read.
 */
export function LabelPicker({ kind, refId, context }: { kind: LabelKind; refId: string; context?: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const labels = useLabels();
  const links = useLabelLinks(kind);
  const ops = useLabelOps();
  const [name, setName] = useState('');
  const [colour, setColour] = useState<LabelColour>('blue');
  if (labels.isError || !labels.data) return null;
  const mine = new Set(links.data?.find((x) => x.ref_id === refId)?.label_ids ?? []);
  const on = labels.data.filter((l) => mine.has(l.id));
  const fail = () => toast(t('common.error'), 'err');
  const add = () => {
    const n = name.trim();
    if (!n) return;
    ops.create.mutate({ name: n, colour }, { onSuccess: (l) => { setName(''); ops.assign.mutate({ id: l.id, kind, ref_id: refId, ...(context ? { context } : {}), on: true }); }, onError: (e) => toast(e.status === 409 ? t('labels.exists') : t('common.error'), 'err') });
  };
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid={`labels-${kind}`}>
      {on.map((l) => <LabelChip key={l.id} l={l} />)}
      <details className="relative">
        <summary className="btn cursor-pointer list-none px-2 py-1 text-xs" data-testid="labels-open"><Tag size={12} aria-hidden className="me-1 inline" />{t('labels.button')}</summary>
        <div className="card absolute start-0 z-30 mt-1 w-64 space-y-2 p-2 text-sm shadow-lg">
          <p className="text-xs text-mute">{t('labels.personal')} <Link className="text-accentText underline" to="/my-labels" data-testid="labels-page-link">{t('labels.page_title')}</Link></p>
          <ul className="space-y-1">
            {labels.data.map((l) => (
              <li key={l.id} className="flex items-center gap-2">
                <label className="flex flex-1 items-center gap-2">
                  <input type="checkbox" checked={mine.has(l.id)} data-testid={`label-tick-${l.name}`}
                    onChange={(e) => ops.assign.mutate({ id: l.id, kind, ref_id: refId, ...(context ? { context } : {}), on: e.target.checked }, { onError: fail })} />
                  <LabelChip l={l} />
                </label>
                <button type="button" className="text-xs text-mute underline" data-testid={`label-hide-${l.name}`} onClick={() => ops.archive.mutate(l.id, { onError: fail })}>{t('labels.hide')}</button>
              </li>
            ))}
            {!labels.data.length && <li className="text-xs text-mute">{t('labels.none')}</li>}
          </ul>
          <div className="flex items-center gap-1 border-t border-line pt-2">
            <input className="input min-w-0 flex-1 py-1 text-xs" maxLength={40} value={name} placeholder={t('labels.new_name')} aria-label={t('labels.new_name')} data-testid="label-new-name"
              onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
            <select className="input w-auto py-1 text-xs" value={colour} aria-label={t('labels.colour')} data-testid="label-new-colour" onChange={(e) => setColour(e.target.value as LabelColour)}>
              {LABEL_COLOURS.map((c) => <option key={c} value={c}>{t(`labels.c_${c}`)}</option>)}
            </select>
            <button type="button" className="btn btn-accent px-2 py-1 text-xs" data-testid="label-new-add" disabled={!name.trim() || ops.create.isPending} onClick={add}>{t('labels.add')}</button>
          </div>
        </div>
      </details>
    </div>
  );
}
