import * as Dialog from '@radix-ui/react-dialog';
import { GitCompare, Minus, Pencil, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTemplateChanges, type TemplateChanges } from '@/api/registers';
import { Tip } from './Tip';

const day = (iso?: string | null) => (iso ? iso.slice(0, 10) : '');

/** The three lists of one comparison: columns added, removed and renamed. Nothing is deleted anywhere; this only reads the saved versions. */
export function ChangeList({ c }: { c: TemplateChanges }) {
  const { t } = useTranslation();
  const none = !c.added.length && !c.removed.length && !c.renamed.length;
  return (
    <div className="space-y-2 text-sm" data-testid="tpl-changes-list">
      {none && <p className="text-mute" data-testid="tpl-changes-none">{t('tplChanges.none')}</p>}
      {!!c.added.length && (
        <section data-testid="tpl-changes-added"><h3 className="flex items-center gap-1 font-semibold text-doneInk"><Plus size={14} aria-hidden />{t('tplChanges.added', { count: c.added.length })}</h3>
          <ul className="ps-5">{c.added.map((x) => <li key={x.code}>{x.label} <span className="mono text-mute">{x.code}</span></li>)}</ul></section>
      )}
      {!!c.removed.length && (
        <section data-testid="tpl-changes-removed"><h3 className="flex items-center gap-1 font-semibold text-lateInk"><Minus size={14} aria-hidden />{t('tplChanges.removed', { count: c.removed.length })}</h3>
          <ul className="ps-5">{c.removed.map((x) => <li key={x.code}>{x.label} <span className="mono text-mute">{x.code}</span></li>)}</ul></section>
      )}
      {!!c.renamed.length && (
        <section data-testid="tpl-changes-renamed"><h3 className="flex items-center gap-1 font-semibold text-waitInk"><Pencil size={14} aria-hidden />{t('tplChanges.renamed', { count: c.renamed.length })}</h3>
          <ul className="ps-5">{c.renamed.map((x) => <li key={x.code}><span className="line-through text-mute">{x.from_label}</span> → {x.to_label} <span className="mono text-mute">{x.code}</span></li>)}</ul></section>
      )}
    </div>
  );
}

/** Button that opens the comparison between the current version and the one before it. Shown only when the template has more than one version. */
export function WhatChangedButton({ templateId, version }: { templateId: string; version: number }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const q = useTemplateChanges(templateId, open);
  if (version < 2) return null;
  const label = t('tplChanges.button');
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Tip text={t('tplChanges.button_hint', { version })}>
        <button type="button" className="btn px-2 py-1 text-xs" data-testid={`tpl-changes-${templateId}`} aria-label={`${label} ${templateId}`} onClick={() => setOpen(true)}><GitCompare size={14} aria-hidden />{label}</button>
      </Tip>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-scrim/60" />
        <Dialog.Content data-testid="tpl-changes-dialog" className="card fixed inset-x-0 top-[12vh] z-[70] mx-auto max-h-[76vh] w-[min(480px,94vw)] space-y-3 overflow-y-auto p-5">
          <div className="flex items-start gap-2">
            <Dialog.Title className="flex-1 text-lg font-bold">{t('tplChanges.title', { id: templateId })}</Dialog.Title>
            <Tip text={t('common.close')}><Dialog.Close className="btn px-2 py-1" aria-label={t('common.close')}><X size={14} aria-hidden /></Dialog.Close></Tip>
          </div>
          <Dialog.Description className="text-mute">{q.data ? t('tplChanges.between', { from: q.data.from ?? '-', to: q.data.to, date: day(q.data.issued_at) }) : t('tplChanges.loading')}</Dialog.Description>
          {q.data?.reason && <p className="text-sm text-mute" data-testid="tpl-changes-reason">{q.data.reason}</p>}
          {q.isError && <p role="alert" className="text-lateInk">{t('tplChanges.error')}</p>}
          {q.data && <ChangeList c={q.data} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** In the upload dialog: the version badge ("v3 current") and, when the template changed, what changed, so an old file is no surprise. */
export function TemplateVersionNotice({ templateId }: { templateId: string }) {
  const { t } = useTranslation();
  const q = useTemplateChanges(templateId);
  const [open, setOpen] = useState(false);
  const c = q.data;
  if (!c) return null;
  const changed = c.from !== null && (c.added.length + c.removed.length + c.renamed.length > 0);
  return (
    <div className="rounded-md bg-card2 p-2 text-sm" data-testid="tpl-version-notice" data-version={c.to}>
      <p className="flex flex-wrap items-center gap-2">
        <span className="chip bg-accentSoft text-accentText" data-testid="tpl-version-current">v{c.to}</span>
        <span>{t('tplChanges.current_ok')}</span>
      </p>
      {changed && (
        <div className="mt-1" data-testid="tpl-version-changed">
          <p className="text-waitInk">{t('tplChanges.notice', { date: day(c.issued_at), added: c.added.length, removed: c.removed.length, renamed: c.renamed.length })}</p>
          <button type="button" className="btn mt-1 px-2 py-1 text-xs" data-testid="tpl-version-toggle" aria-expanded={open} onClick={() => setOpen(!open)}><GitCompare size={14} aria-hidden />{t('tplChanges.button')}</button>
          {open && <div className="mt-2"><ChangeList c={c} /></div>}
        </div>
      )}
    </div>
  );
}
