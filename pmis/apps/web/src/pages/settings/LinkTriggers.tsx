import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLinkTriggers, usePreviewLinkTrigger, useSaveLinkTrigger, type LinkTriggerPreview } from '@/api/settings';
import { QueryFallback } from '@/components/States';
import { useToast } from '@/components/Toast';
import { errText } from '@/components/FormDialog';

/**
 * Settings, Alerts, Link triggers (admin only; contract 0.15.488, migration 0629). Per declared register link, opt-in: when the approved record that holds the
 * link differs from the approved record it links to in a date or list field, the daily job PROPOSES a new version (before and after value). It never writes a
 * record: an entry holder of the target row applies the proposal, through the new-version call, the Matrix and the approval chain. Off by default; a dry run
 * shows what a run would propose and writes nothing.
 */
export function LinkTriggers() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useLinkTriggers();
  const save = useSaveLinkTrigger();
  const preview = usePreviewLinkTrigger();
  const [linkKey, setLinkKey] = useState('');
  const [src, setSrc] = useState('');
  const [dst, setDst] = useState('');
  const [reason, setReason] = useState('');
  const [shown, setShown] = useState<{ id: string; data: LinkTriggerPreview } | null>(null);
  if (!q.data) return <QueryFallback queries={[q]} testid="lt-loading" />;
  const links = q.data.links;
  const link = links.find((l) => `${l.register_key}.${l.field_code}` === linkKey);
  const srcType = link?.source_fields.find((f) => f.code === src)?.field_type;
  const dstOptions = (link?.target_fields ?? []).filter((f) => srcType === undefined || f.field_type === srcType);
  const canAdd = !!link && src !== '' && dst !== '' && reason.trim().length >= 3 && !save.isPending;
  const fail = (e: unknown) => toast(errText(e, t), 'err');
  return (
    <section className="space-y-4" data-testid="link-triggers">
      <header>
        <h2 className="text-lg font-semibold">{t('linkTriggers.title')}</h2>
        <p className="text-sm text-mute">{t('linkTriggers.intro')}</p>
      </header>
      {q.data.triggers.length === 0 ? <p className="text-sm text-mute" data-testid="lt-empty">{t('linkTriggers.empty')}</p> : (
        <ul className="space-y-2" data-testid="lt-list">
          {q.data.triggers.map((x) => (
            <li key={x.id} className="rounded border border-line p-3 text-sm" data-testid={`lt-row-${x.id}`}>
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-semibold" dir="ltr">{x.register_key}.{x.field_code} → {x.target_register}</span>
                <span className="text-mute" dir="ltr">{x.source_field} → {x.target_field}</span>
                <span className="text-mute">{t('linkTriggers.open', { n: x.open_proposals })}</span>
                <label className="ms-auto flex items-center gap-2">
                  <input type="checkbox" checked={x.enabled} disabled={save.isPending} data-testid={`lt-enabled-${x.id}`} title={t('linkTriggers.enabled_help')}
                    onChange={(e) => {
                      const r = window.prompt(t('linkTriggers.reason'));
                      if (r && r.trim().length >= 3) save.mutate({ id: x.id, body: { register_key: x.register_key, field_code: x.field_code, source_field: x.source_field, target_field: x.target_field, enabled: e.target.checked, reason: r.trim() } }, { onError: fail });
                    }} />
                  {t('linkTriggers.enabled')}
                </label>
                <button type="button" className="btn px-2 py-1 text-xs" data-testid={`lt-preview-${x.id}`} disabled={preview.isPending}
                  onClick={() => preview.mutate(x.id, { onSuccess: (data) => setShown({ id: x.id, data }), onError: fail })}>{t('linkTriggers.dry_run')}</button>
              </div>
              {shown?.id === x.id && (
                <div className="mt-2 rounded bg-hover p-2" data-testid={`lt-preview-result-${x.id}`}>
                  <p className="font-semibold">{t('linkTriggers.dry_total', { n: shown.data.total })}</p>
                  <ul className="mt-1 space-y-0.5 text-xs">
                    {shown.data.items.map((it, i) => <li key={i} dir="ltr">{it.source_code ?? '-'} → {it.target_code ?? it.target_register}: {it.before ?? '-'} → {it.after ?? '-'}</li>)}
                  </ul>
                  <p className="mt-1 text-xs text-mute">{t('linkTriggers.dry_note')}</p>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <form className="flex flex-wrap items-end gap-3 rounded border border-line p-3 text-sm" data-testid="lt-form"
        onSubmit={(e) => { e.preventDefault(); if (canAdd && link) save.mutate({ id: null, body: { register_key: link.register_key, field_code: link.field_code, source_field: src, target_field: dst, enabled: false, reason: reason.trim() } }, { onSuccess: () => { setSrc(''); setDst(''); setReason(''); }, onError: fail }); }}>
        <label className="flex flex-col gap-0.5"><span className="text-xs text-mute">{t('linkTriggers.link')}</span>
          <select className="input" data-testid="lt-link" value={linkKey} onChange={(e) => { setLinkKey(e.target.value); setSrc(''); setDst(''); }}>
            <option value="">{t('registers.choose')}</option>
            {links.map((l) => <option key={`${l.register_key}.${l.field_code}`} value={`${l.register_key}.${l.field_code}`}>{l.register_key}.{l.field_code} → {l.target_register}</option>)}
          </select></label>
        <label className="flex flex-col gap-0.5"><span className="text-xs text-mute">{t('linkTriggers.source_field')}</span>
          <select className="input" data-testid="lt-src" value={src} onChange={(e) => { setSrc(e.target.value); setDst(''); }}>
            <option value="">{t('registers.choose')}</option>
            {(link?.source_fields ?? []).map((f) => <option key={f.code} value={f.code}>{f.code} ({f.field_type})</option>)}
          </select></label>
        <label className="flex flex-col gap-0.5"><span className="text-xs text-mute">{t('linkTriggers.target_field')}</span>
          <select className="input" data-testid="lt-dst" value={dst} onChange={(e) => setDst(e.target.value)}>
            <option value="">{t('registers.choose')}</option>
            {dstOptions.map((f) => <option key={f.code} value={f.code}>{f.code} ({f.field_type})</option>)}
          </select></label>
        <label className="flex flex-col gap-0.5"><span className="text-xs text-mute">{t('linkTriggers.reason')}</span>
          <input className="input w-64" data-testid="lt-reason" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <button type="submit" className="btn btn-accent" disabled={!canAdd} data-testid="lt-add">{t('linkTriggers.add')}</button>
        <p className="w-full text-xs text-mute">{t('linkTriggers.add_help')}</p>
      </form>
    </section>
  );
}
